import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { openAudiogramLedger } from "./audiogram-ledger.mjs";
import { runLoggedStage } from "./pipeline-logger.mjs";
import { acquireClipPackageAssets } from "./clip-package-assets.mjs";
import { buildSelectionRecipe } from "./clip-selection-contract.mjs";
import { sanitizeErrorDiagnostic } from "./error-diagnostics.mjs";
import { createHttpJevClient } from "./jev-client.mjs";
import { enqueueCompletedArtifact, hashArtifact } from "./publishing-completion.mjs";
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
import { parseYouTubeVideoUrl, validateYouTubeMetadata } from "./youtube-url-core.mjs";

const defaultApplicationSupport = join(
  homedir(),
  "Library",
  "Application Support",
  "Audiogram Inbox",
);
const TREATMENTS = [{ id: "audiogram-basic", version: "1" }];

const failedResult = ({ source = null, code, message, artifactPaths = [], failures }) => ({
  contractVersion: 1,
  status: artifactPaths.length > 0 ? "partial" : "failed",
  source,
  artifactPaths,
  ...(failures?.length ? { failures } : {}),
  error: { code, message },
});

const safeErrorMessage = (error, projectRoot) =>
  sanitizeErrorDiagnostic(error, {
    sensitivePaths: isAbsolute(projectRoot) && projectRoot !== "/" ? [projectRoot] : [],
    maximumLength: 600,
  });

const listRenderedArtifacts = async ({ ledger, videoId, packageVersion, projectRoot }) => {
  const job = ledger.getPackageJob(videoId, packageVersion);
  if (!job) return [];

  const artifacts = [];
  for (const clipPackage of ledger.listClipPackages(job.id)) {
    for (const run of ledger.listTreatmentRuns(clipPackage.id)) {
      if (
        run.treatmentId !== "audiogram-basic" ||
        run.treatmentVersion !== "1" ||
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
  projectRoot = process.env.AUDIOGRAM_PROJECT_ROOT ?? process.cwd(),
  environment = process.env,
  dependencies = {},
}) => {
  const root = resolve(projectRoot);
  const eventLogger = { event: dependencies.onEvent };
  let activeStage = "intake";
  let parsedUrl;
  try {
    parsedUrl = await runLoggedStage({
      logger: eventLogger,
      stage: "intake",
      operation: () => parseYouTubeVideoUrl(url),
    });
  } catch (error) {
    return failedResult({
      code: error.code ?? "INVALID_URL",
      message: safeErrorMessage(error, root),
      failures: [{ stage: "intake", code: error.code ?? "INVALID_URL", message: "The video URL is not valid." }],
    });
  }

  const fetchMetadata = dependencies.fetchMetadata ?? fetchYtDlpMetadata;
  let source;
  let sourceMetadata;
  activeStage = "metadata";
  try {
    source = await runLoggedStage({
      logger: eventLogger,
      stage: "metadata",
      videoId: parsedUrl.videoId,
      operation: async () => {
        sourceMetadata = await fetchMetadata(parsedUrl.sourceUrl);
        return validateYouTubeMetadata(sourceMetadata, parsedUrl.videoId);
      },
    });
  } catch (error) {
    return failedResult({
      code: error.code ?? "METADATA_FAILED",
      message: safeErrorMessage(error, root),
      failures: [{ stage: "metadata", code: error.code ?? "METADATA_FAILED", message: "Video metadata could not be read." }],
    });
  }
  const contractSource = { videoId: source.videoId, title: source.title, url: source.sourceUrl };
  activeStage = "setup";

  let ledger;
  let publishingLedger;
  let packageVersion;
  let analysisFailures = [];
  let processing;
  try {
    const selectConfig = (dependencies.resolveSelectionConfig ?? resolveSelectionConfig)(environment);
    const selectionRecipe = (dependencies.buildSelectionRecipe ?? buildSelectionRecipe)(selectConfig);
    packageVersion = selectConfig.packageVersion;

    const ledgerPath =
      environment.AUDIOGRAM_DB_PATH ?? join(defaultApplicationSupport, "audiograms.sqlite");
    const approvalLedgerPath =
      environment.INSTAGRAM_PUBLISHING_DB_PATH ?? resolvePublishingLedgerPath(environment);
    await Promise.all([
      mkdir(dirname(ledgerPath), { recursive: true, mode: 0o700 }),
      mkdir(dirname(approvalLedgerPath), { recursive: true, mode: 0o700 }),
    ]);

    ledger = (dependencies.openLedger ?? openAudiogramLedger)(ledgerPath, {
      selectionRecipe,
      packageVersion,
      legacyHeatmapRecipeMap: selectConfig.legacyHeatmapRecipeMap,
    });
    publishingLedger = (dependencies.createPublishingLedger ?? createPublishingLedger)(
      approvalLedgerPath,
    );

    const hasJevEndpoint = Boolean(environment.TYPESAFE_JEV_ENDPOINT);
    const hasJevApiKey = Boolean(environment.TYPESAFE_JEV_API_KEY);
    if (hasJevEndpoint !== hasJevApiKey) {
      throw new Error("TYPESAFE_JEV_ENDPOINT and TYPESAFE_JEV_API_KEY must be provided together");
    }
    const jevClient = hasJevEndpoint
      ? (dependencies.createJevClient ?? createHttpJevClient)({
          endpoint: environment.TYPESAFE_JEV_ENDPOINT,
          apiKey: environment.TYPESAFE_JEV_API_KEY,
        })
      : undefined;

    if (dependencies.retryFailedPipeline) {
      ledger.resetFailedWorkForRetry({
        videoId: source.videoId,
        packageVersion,
      });
    }

    activeStage = selectConfig.selectorId === "transcript-llm" ? "transcript" : "selection";
    const pipeline = await (dependencies.syncAndAnalyzeInbox ?? syncAndAnalyzeInbox)({
      ledger,
      playlist: { id: null, title: "Single URL" },
      videos: [{ videoId: source.videoId, title: source.title, url: source.sourceUrl }],
      selectionConfig: selectConfig,
      selectionRecipe,
      fetchMetadata: async (requestedUrl) => {
        if (requestedUrl !== source.sourceUrl) {
          throw new Error("Pipeline requested metadata for an unexpected source URL");
        }
        return sourceMetadata;
      },
      ...(dependencies.fetchTranscript
        ? { fetchTranscript: dependencies.fetchTranscript }
        : {}),
      ...(dependencies.createProvider
        ? { createProvider: dependencies.createProvider }
        : {}),
      ...(dependencies.onEvent ? { onEvent: dependencies.onEvent } : {}),
      ...(jevClient ? { jevClient } : {}),
    });
    analysisFailures = pipeline.analyzed.filter(({ status }) => status === "failed");

    const treatmentDeps = {
      ledger,
      registry: dependencies.registry ?? treatmentRegistry,
      treatments: TREATMENTS,
      loadTranscriptForPackage: (packageId) => ledger.getTranscriptForPackage(packageId),
      acquireAssets: (clipPackage) =>
        (dependencies.acquireAssets ?? acquireClipPackageAssets)(clipPackage, {
          projectRoot: root,
        }),
      renderTreatment: ({ clipPackage, treatment }) =>
        (dependencies.renderTreatment ?? renderTreatmentRun)(
          { clipPackage, treatment },
          { projectRoot: root },
        ),
      projectRoot: root,
      videoId: source.videoId,
      ...(dependencies.onEvent ? { onEvent: dependencies.onEvent } : {}),
      onArtifactComplete: async ({ artifactRelativePath, artifactHash, clipPackage, treatment }) =>
        await (dependencies.enqueueCompletedArtifact ?? enqueueCompletedArtifact)({
          ledger: publishingLedger,
          projectRoot: root,
          artifactRelativePath,
          artifactHash:
            artifactHash ??
            await (dependencies.hashArtifact ?? hashArtifact)(root, artifactRelativePath),
          accountId: resolvePublishingAccountId(environment),
          sourceVideoId: source.videoId,
          clipPackageId: clipPackage.id,
          treatmentId: treatment.id,
          treatmentVersion: treatment.version,
          title: clipPackage.title,
        }),
    };
    activeStage = "assets";
    processing = await (dependencies.processClipPackages ?? processClipPackages)(treatmentDeps);

    const artifactPaths = await runLoggedStage({
      logger: eventLogger,
      stage: "artifact_verification",
      videoId: source.videoId,
      operation: () => listRenderedArtifacts({
        ledger,
        videoId: source.videoId,
        packageVersion,
        projectRoot: root,
      }),
    });
    const job = ledger.getPackageJob(source.videoId, packageVersion);
    const failures = [
      ...analysisFailures.map(({ failure }) => failure).filter(Boolean).map((failure) => ({
        ...failure,
        message: failure.stage === "transcript"
          ? "Transcript acquisition failed."
          : failure.stage === "jev"
            ? "Jev analysis failed."
            : "Clip selection failed.",
      })),
      ...(processing.failures ?? []).map((failure) => ({
        ...failure,
        message: failure.stage === "assets" ? "Clip assets could not be prepared." : "Clip rendering failed.",
      })),
    ];
    const hasProcessingFailures =
      analysisFailures.length > 0 ||
      processing.packages.failed > 0 ||
      processing.treatments.failed > 0 ||
      job?.status === "failed" ||
      ledger.listClipPackages(job?.id).some((item) => item.status === "failed") ||
      ledger
        .listClipPackages(job?.id)
        .some((item) => ledger.listTreatmentRuns(item.id).some((run) => run.status === "failed"));

    if (hasProcessingFailures) {
      activeStage = "artifact_verification";
      return failedResult({
        source: contractSource,
        code: "PROCESSING_FAILED",
        message: failures[0]?.message ?? "Audiogram processing failed.",
        artifactPaths,
        failures: failures.length ? failures : [{ stage: activeStage, code: "PROCESSING_FAILED", message: "Audiogram processing failed." }],
      });
    }
    if (job?.status === "no_selection" || (job && ledger.listClipPackages(job.id).length === 0)) {
      return {
        contractVersion: 1,
        status: "no_clips",
        source: contractSource,
        artifactPaths: [],
        error: { code: "NO_CLIPS", message: "No clips were selected from this video." },
      };
    }
    if (artifactPaths.length === 0) {
      return failedResult({
        source: contractSource,
        code: "NO_VERIFIED_ARTIFACTS",
        message: "Processing did not produce a verified MP4 artifact.",
        failures: [{
          stage: "artifact_verification",
          code: "NO_VERIFIED_ARTIFACTS",
          message: "Processing did not produce a verified MP4 artifact.",
        }],
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
          projectRoot: root,
        });
      } catch {
        // Preserve the original failure; artifact collection is best effort.
      }
    }
    return failedResult({
      source: source ? contractSource : null,
      code: activeStage === "setup" ? "PIPELINE_SETUP_FAILED" : "PROCESSING_FAILED",
      message: safeErrorMessage(error, root),
      artifactPaths,
      failures: [{
        stage: activeStage,
        code: activeStage === "metadata"
          ? "METADATA_FAILED"
          : activeStage === "setup"
            ? "PIPELINE_SETUP_FAILED"
            : "PROCESSING_FAILED",
        message: activeStage === "metadata"
          ? "Video metadata could not be read."
          : activeStage === "setup"
            ? "Audiogram processing could not be configured."
            : "Audiogram processing failed.",
      }],
    });
  } finally {
    publishingLedger?.close();
    ledger?.close();
  }
};
