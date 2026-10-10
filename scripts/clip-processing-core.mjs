import { hashArtifact } from "./publishing-completion.mjs";
import { sanitizeErrorDiagnostic } from "./error-diagnostics.mjs";
import { runLoggedStage } from "./pipeline-logger.mjs";

export const processClipPackages = async ({
  ledger,
  registry,
  treatments,
  loadTranscriptForPackage,
  acquireAssets,
  renderTreatment,
  onArtifactComplete,
  projectRoot = process.cwd(),
  artifactRoot,
  videoId,
  onEvent,
  retryFailedRenders = false,
}) => {
  if (typeof retryFailedRenders !== "boolean")
    throw new Error("retryFailedRenders must be boolean");
  if (retryFailedRenders && !videoId)
    throw new Error("retryFailedRenders requires videoId");
  const result = {
    packages: { ready: 0, failed: 0 },
    treatments: { rendered: 0, failed: 0 },
    failures: [],
  };
  const transcriptsById = new Map();
  const requestedKeys = new Set(
    treatments.map(({ id, version }) => `${id}@${version}`),
  );

  const matchesVideo = (item) => !videoId || item.videoId === videoId;
  for (const clipPackage of ledger
    .listSelectedPackages()
    .filter(matchesVideo)) {
    try {
      const loadedTranscript = await loadTranscriptForPackage(clipPackage.id);
      let transcript = null;
      if (loadedTranscript) {
        transcript = transcriptsById.get(loadedTranscript.id);
        if (!transcript) {
          transcript = loadedTranscript;
          transcriptsById.set(loadedTranscript.id, transcript);
        }
      }
      const assets = await runLoggedStage({
        logger: { event: onEvent },
        stage: "assets",
        videoId: clipPackage.videoId ?? clipPackage.sourceVideoId,
        clipPackageId: clipPackage.id,
        operation: () => acquireAssets({ ...clipPackage, transcript }),
      });
      ledger.markPackageReady({ packageId: clipPackage.id, assets });
      result.packages.ready += 1;
    } catch (error) {
      ledger.markPackageFailed(clipPackage.id, sanitizeErrorDiagnostic(error));
      result.packages.failed += 1;
      result.failures.push({
        stage: "assets",
        code: "ASSET_FAILED",
        packageId: clipPackage.id,
      });
    }
  }

  for (const clipPackage of ledger.listReadyPackages().filter(matchesVideo)) {
    for (const { id, version } of treatments) {
      registry.get(id, version);
      const run = ledger.ensureTreatmentRun({
        packageId: clipPackage.id,
        treatmentId: id,
        treatmentVersion: version,
      });
      if (retryFailedRenders && run.status === "failed") {
        ledger.retryFailedTreatmentRun(run.id);
      }
    }
  }

  for (const run of ledger
    .listPendingTreatmentRuns()
    .filter(
      (item) =>
        (!videoId || item.videoId === videoId) &&
        requestedKeys.has(`${item.treatmentId}@${item.treatmentVersion}`),
    )) {
    try {
      const treatment = registry.get(run.treatmentId, run.treatmentVersion);
      const clipPackage = ledger.getClipPackage(run.clipPackageId);
      const artifactRelativePath = await runLoggedStage({
        logger: { event: onEvent },
        stage: "render",
        videoId: run.videoId,
        clipPackageId: run.clipPackageId,
        treatmentId: run.treatmentId,
        operation: () => renderTreatment({ clipPackage, treatment }),
      });
      if (onArtifactComplete) {
        result.publishing ??= { queued: 0, failed: 0 };
        try {
          await runLoggedStage({
            logger: { event: onEvent },
            stage: "queue",
            videoId: run.videoId,
            clipPackageId: run.clipPackageId,
            treatmentId: run.treatmentId,
            operation: async () =>
              onArtifactComplete({
                artifactRelativePath,
                artifactHash: await hashArtifact(
                  projectRoot,
                  artifactRelativePath,
                  { artifactRoot },
                ),
                run,
                clipPackage,
                treatment,
              }),
          });
          result.publishing.queued += 1;
        } catch (error) {
          result.publishing.failed += 1;
          result.publishing.lastError = sanitizeErrorDiagnostic(error);
        }
      }
      ledger.markTreatmentRunRendered(run.id, artifactRelativePath);
      result.treatments.rendered += 1;
    } catch (error) {
      ledger.markTreatmentRunFailed(run.id, sanitizeErrorDiagnostic(error));
      result.treatments.failed += 1;
      result.failures.push({
        stage: "render",
        code: "RENDER_FAILED",
        packageId: run.clipPackageId,
      });
    }
  }

  return result;
};
