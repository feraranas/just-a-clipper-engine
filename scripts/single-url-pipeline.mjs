import { resolveTemplateSelectionConfig } from "./template-selection-config.mjs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { openAudiogramLedger } from "./audiogram-ledger.mjs";
import { acquireClipPackageAssets } from "./clip-package-assets.mjs";
import { buildSelectionRecipe } from "./clip-selection-contract.mjs";
import { sanitizeErrorDiagnostic } from "./error-diagnostics.mjs";
import { createHttpJevClient } from "./jev-client.mjs";
import {
  enqueueCompletedArtifact,
  hashArtifact,
} from "./publishing-completion.mjs";
import { createPublishingLedger } from "./publishing-ledger.mjs";
import {
  resolvePublishingAccountId,
  resolvePublishingLedgerPath,
} from "./publishing-config.mjs";
import { processClipPackages } from "./clip-processing-core.mjs";
import { treatmentRegistry } from "./treatment-registry.mjs";
import { renderTreatmentRun } from "./treatment-runner.mjs";
import { syncAndAnalyzeInbox } from "./youtube-inbox-pipeline-core.mjs";
import { fetchYtDlpMetadata } from "./youtube-heatmap-core.mjs";
import { resolveSelectionConfig } from "./youtube-pipeline-config.mjs";
import {
  parseYouTubeVideoUrl,
  validateYouTubeMetadata,
} from "./youtube-url-core.mjs";

const defaultApplicationSupport = join(
  homedir(),
  "Library",
  "Application Support",
  "Audiogram Inbox",
);

const failedResult = ({
  source = null,
  code,
  message,
  artifactPaths = [],
}) => ({
  contractVersion: 1,
  status: "failed",
  source,
  artifactPaths,
  error: { code, message },
});

const safeErrorMessage = (error, projectRoot) =>
  sanitizeErrorDiagnostic(error, {
    sensitivePaths:
      isAbsolute(projectRoot) && projectRoot !== "/" ? [projectRoot] : [],
    maximumLength: 600,
  });

const listRenderedArtifacts = async ({
  ledger,
  videoId,
  packageVersion,
  projectRoot,
  treatment,
}) => {
  const job = ledger.getPackageJob(videoId, packageVersion);
  if (!job) return [];

  const artifacts = [];
  for (const clipPackage of ledger.listClipPackages(job.id)) {
    for (const run of ledger.listTreatmentRuns(clipPackage.id)) {
      if (
        run.treatmentId !== treatment.id ||
        run.treatmentVersion !== treatment.version ||
        run.status !== "rendered" ||
        typeof run.artifactRelativePath !== "string"
      ) {
        continue;
      }

      const artifactPath = run.artifactRelativePath;
      const resolvedPath = resolve(projectRoot, artifactPath);
      const relativePath = relative(projectRoot, resolvedPath);
      if (
        isAbsolute(artifactPath) ||
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        !relativePath.split(sep).join("/").startsWith("out/treatments/") ||
        !artifactPath.toLowerCase().endsWith(".mp4")
      ) {
        continue;
      }

      try {
        const details = await stat(resolvedPath);
        const [canonicalRoot, canonicalArtifact] = await Promise.all([
          realpath(projectRoot),
          realpath(resolvedPath),
        ]);
        const canonicalRelative = relative(canonicalRoot, canonicalArtifact);
        if (
          details.isFile() &&
          details.size > 0 &&
          canonicalRelative !== ".." &&
          !canonicalRelative.startsWith(`..${sep}`)
        ) {
          artifacts.push(relativePath.split(sep).join("/"));
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return [...new Set(artifacts)];
};

export const runSingleUrlPipeline = async ({
  url,
  templateSelection,
  projectRoot = process.env.AUDIOGRAM_PROJECT_ROOT ?? process.cwd(),
  environment = process.env,
  dependencies = {},
}) => {
  const root = resolve(projectRoot);
  let resolved;
  try {
    resolved = (
      dependencies.resolveTemplateSelectionConfig ??
      resolveTemplateSelectionConfig
    )({ request: templateSelection, environment });
  } catch (error) {
    return failedResult({
      code: "INVALID_TEMPLATE_SELECTION",
      message: safeErrorMessage(error, root),
    });
  }
  let parsedUrl;
  try {
    parsedUrl = parseYouTubeVideoUrl(url);
  } catch (error) {
    return failedResult({
      code: error.code ?? "INVALID_URL",
      message: safeErrorMessage(error, root),
    });
  }

  const fetchMetadata = dependencies.fetchMetadata ?? fetchYtDlpMetadata;
  let source;
  let sourceMetadata;
  try {
    sourceMetadata = await fetchMetadata(parsedUrl.sourceUrl);
    source = validateYouTubeMetadata(sourceMetadata, parsedUrl.videoId);
  } catch (error) {
    return failedResult({
      code: error.code ?? "METADATA_FAILED",
      message: safeErrorMessage(error, root),
    });
  }
  const contractSource = {
    videoId: source.videoId,
    title: source.title,
    url: source.sourceUrl,
  };

  let ledger;
  let publishingLedger;
  let packageVersion;
  let analysisFailures = [];
  let processing;
  try {
    const selectConfig = (
      dependencies.resolveSelectionConfig ?? resolveSelectionConfig
    )(environment);
    const selectionRecipe = (
      dependencies.buildSelectionRecipe ?? buildSelectionRecipe
    )(selectConfig);
    packageVersion = selectConfig.packageVersion;

    const ledgerPath =
      environment.AUDIOGRAM_DB_PATH ??
      join(defaultApplicationSupport, "audiograms.sqlite");
    const approvalLedgerPath =
      environment.INSTAGRAM_PUBLISHING_DB_PATH ??
      resolvePublishingLedgerPath(environment);
    await Promise.all([
      mkdir(dirname(ledgerPath), { recursive: true, mode: 0o700 }),
      mkdir(dirname(approvalLedgerPath), { recursive: true, mode: 0o700 }),
    ]);

    ledger = (dependencies.openLedger ?? openAudiogramLedger)(ledgerPath, {
      selectionRecipe,
      packageVersion,
      legacyHeatmapRecipeMap: selectConfig.legacyHeatmapRecipeMap,
    });
    publishingLedger = (
      dependencies.createPublishingLedger ?? createPublishingLedger
    )(approvalLedgerPath);

    const hasJevEndpoint = Boolean(environment.TYPESAFE_JEV_ENDPOINT);
    const hasJevApiKey = Boolean(environment.TYPESAFE_JEV_API_KEY);
    if (hasJevEndpoint !== hasJevApiKey) {
      throw new Error(
        "TYPESAFE_JEV_ENDPOINT and TYPESAFE_JEV_API_KEY must be provided together",
      );
    }
    const jevClient = hasJevEndpoint
      ? (dependencies.createJevClient ?? createHttpJevClient)({
          endpoint: environment.TYPESAFE_JEV_ENDPOINT,
          apiKey: environment.TYPESAFE_JEV_API_KEY,
        })
      : undefined;

    const pipeline = await (
      dependencies.syncAndAnalyzeInbox ?? syncAndAnalyzeInbox
    )({
      ledger,
      playlist: { id: null, title: "Single URL" },
      videos: [
        { videoId: source.videoId, title: source.title, url: source.sourceUrl },
      ],
      selectionConfig: selectConfig,
      selectionRecipe,
      fetchMetadata: async (requestedUrl) => {
        if (requestedUrl !== source.sourceUrl) {
          throw new Error(
            "Pipeline requested metadata for an unexpected source URL",
          );
        }
        return sourceMetadata;
      },
      ...(dependencies.fetchTranscript
        ? { fetchTranscript: dependencies.fetchTranscript }
        : {}),
      ...(dependencies.createProvider
        ? { createProvider: dependencies.createProvider }
        : {}),
      ...(jevClient ? { jevClient } : {}),
    });
    analysisFailures = pipeline.analyzed.filter(
      ({ status }) => status === "failed",
    );

    const treatmentDeps = {
      ledger,
      registry: dependencies.registry ?? treatmentRegistry,
      treatments: [resolved.treatment],
      loadTranscriptForPackage: (packageId) =>
        ledger.getTranscriptForPackage(packageId),
      acquireAssets: (clipPackage) =>
        (dependencies.acquireAssets ?? acquireClipPackageAssets)(clipPackage, {
          projectRoot: root,
        }),
      renderTreatment: ({ clipPackage, treatment }) =>
        (dependencies.renderTreatment ?? renderTreatmentRun)(
          { clipPackage, treatment, selection: resolved.selection },
          { projectRoot: root },
        ),
      projectRoot: root,
      videoId: source.videoId,
      onArtifactComplete: async ({
        artifactRelativePath,
        artifactHash,
        clipPackage,
        treatment,
      }) =>
        await (
          dependencies.enqueueCompletedArtifact ?? enqueueCompletedArtifact
        )({
          ledger: publishingLedger,
          projectRoot: root,
          artifactRelativePath,
          artifactHash:
            artifactHash ??
            (await (dependencies.hashArtifact ?? hashArtifact)(
              root,
              artifactRelativePath,
            )),
          accountId: resolvePublishingAccountId(environment),
          sourceVideoId: source.videoId,
          clipPackageId: clipPackage.id,
          treatmentId: treatment.id,
          treatmentVersion: treatment.version,
          title: clipPackage.title,
        }),
    };
    processing = await (
      dependencies.processClipPackages ?? processClipPackages
    )(treatmentDeps);

    const artifactPaths = await listRenderedArtifacts({
      ledger,
      videoId: source.videoId,
      packageVersion,
      treatment: resolved.treatment,
      projectRoot: root,
    });
    const job = ledger.getPackageJob(source.videoId, packageVersion);
    const hasProcessingFailures =
      analysisFailures.length > 0 ||
      processing.packages.failed > 0 ||
      processing.treatments.failed > 0 ||
      job?.status === "failed" ||
      ledger
        .listClipPackages(job?.id)
        .some((item) => item.status === "failed") ||
      ledger
        .listClipPackages(job?.id)
        .some((item) =>
          ledger
            .listTreatmentRuns(item.id)
            .some(
              (run) =>
                run.status === "failed" &&
                run.treatmentId === resolved.treatment.id &&
                run.treatmentVersion === resolved.treatment.version,
            ),
        );

    if (hasProcessingFailures) {
      return failedResult({
        source: contractSource,
        code: "PROCESSING_FAILED",
        message: "One or more analysis, asset, or render steps failed.",
        artifactPaths,
      });
    }
    if (
      job?.status === "no_selection" ||
      (job && ledger.listClipPackages(job.id).length === 0)
    ) {
      return {
        contractVersion: 1,
        status: "no_clips",
        source: contractSource,
        artifactPaths: [],
        error: {
          code: "NO_CLIPS",
          message: "No clips were selected from this video.",
        },
      };
    }
    if (artifactPaths.length < ledger.listClipPackages(job.id).length) {
      return failedResult({
        source: contractSource,
        code: "NO_VERIFIED_ARTIFACTS",
        message: "One or more selected clips have no verified MP4 artifact.",
        artifactPaths,
      });
    }

    return {
      contractVersion: 1,
      status: "complete",
      source: contractSource,
      artifactPaths,
    };
  } catch (error) {
    let artifactPaths = [];
    if (ledger && source && packageVersion) {
      try {
        artifactPaths = await listRenderedArtifacts({
          ledger,
          videoId: source.videoId,
          packageVersion,
          treatment: resolved.treatment,
          projectRoot: root,
        });
      } catch {
        // Preserve the original failure; artifact collection is best effort.
      }
    }
    return failedResult({
      source: source ? contractSource : null,
      code: "PROCESSING_FAILED",
      message: safeErrorMessage(error, root),
      artifactPaths,
    });
  } finally {
    publishingLedger?.close();
    ledger?.close();
  }
};
