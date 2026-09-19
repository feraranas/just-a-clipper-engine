export const processClipPackages = async ({
  ledger,
  registry,
  treatments,
  acquireAssets,
  renderTreatment,
}) => {
  const result = {
    packages: {ready: 0, failed: 0},
    treatments: {rendered: 0, failed: 0},
  };

  for (const clipPackage of ledger.listSelectedPackages()) {
    try {
      const assets = await acquireAssets(clipPackage);
      ledger.markPackageReady({packageId: clipPackage.id, assets});
      result.packages.ready += 1;
    } catch (error) {
      ledger.markPackageFailed(
        clipPackage.id,
        error instanceof Error ? error.message : String(error),
      );
      result.packages.failed += 1;
    }
  }

  for (const clipPackage of ledger.listReadyPackages()) {
    for (const {id, version} of treatments) {
      registry.get(id, version);
      ledger.ensureTreatmentRun({
        packageId: clipPackage.id,
        treatmentId: id,
        treatmentVersion: version,
      });
    }
  }

  for (const run of ledger.listPendingTreatmentRuns()) {
    try {
      const treatment = registry.get(run.treatmentId, run.treatmentVersion);
      const clipPackage = ledger.getClipPackage(run.clipPackageId);
      const artifactRelativePath = await renderTreatment({
        clipPackage,
        treatment,
      });
      ledger.markTreatmentRunRendered(run.id, artifactRelativePath);
      result.treatments.rendered += 1;
    } catch (error) {
      ledger.markTreatmentRunFailed(
        run.id,
        error instanceof Error ? error.message : String(error),
      );
      result.treatments.failed += 1;
    }
  }

  return result;
};
