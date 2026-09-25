import { hashArtifact } from "./publishing-completion.mjs";
import { sanitizeErrorDiagnostic } from "./error-diagnostics.mjs";

export const processClipPackages = async ({
  ledger,
  registry,
  treatments,
  loadTranscriptForPackage,
  acquireAssets,
  renderTreatment,
  onArtifactComplete,
  projectRoot = process.cwd(),
  videoId,
}) => {
  const result = {
    packages: { ready: 0, failed: 0 },
    treatments: { rendered: 0, failed: 0 },
  };
  const transcriptsById = new Map();

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
      const assets = await acquireAssets({ ...clipPackage, transcript });
      ledger.markPackageReady({ packageId: clipPackage.id, assets });
      result.packages.ready += 1;
    } catch (error) {
      ledger.markPackageFailed(clipPackage.id, sanitizeErrorDiagnostic(error));
      result.packages.failed += 1;
    }
  }

  for (const clipPackage of ledger.listReadyPackages().filter(matchesVideo)) {
    for (const { id, version } of treatments) {
      registry.get(id, version);
      ledger.ensureTreatmentRun({
        packageId: clipPackage.id,
        treatmentId: id,
        treatmentVersion: version,
      });
    }
  }

  for (const run of ledger
    .listPendingTreatmentRuns()
    .filter((item) => !videoId || item.videoId === videoId)) {
    try {
      const treatment = registry.get(run.treatmentId, run.treatmentVersion);
      const clipPackage = ledger.getClipPackage(run.clipPackageId);
      const artifactRelativePath = await renderTreatment({
        clipPackage,
        treatment,
      });
      if (onArtifactComplete) {
        result.publishing ??= { queued: 0, failed: 0 };
        try {
          await onArtifactComplete({
            artifactRelativePath,
            artifactHash: await hashArtifact(projectRoot, artifactRelativePath),
            run,
            clipPackage,
            treatment,
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
    }
  }

  return result;
};
