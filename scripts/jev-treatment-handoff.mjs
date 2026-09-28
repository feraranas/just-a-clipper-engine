import { renderTreatmentRun } from "./treatment-runner.mjs";

export const renderProjectedPackages = async ({
  packages,
  treatment,
  videoId,
  packageVersion,
  assets,
  render = renderTreatmentRun,
}) => {
  if (!Array.isArray(packages)) throw new Error("Projected packages are required");
  return Promise.all(packages.map(async (packageCandidate) => {
    const clipPackage = {
      ...packageCandidate,
      videoId,
      packageVersion,
      assets,
    };
    const artifactRelativePath = await render({ clipPackage, treatment });
    return { ...clipPackage, artifactRelativePath };
  }));
};
