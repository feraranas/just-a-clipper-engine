import { artifactLocation, hashFile } from "./artifact-store.mjs";
import { resolveStorageConfig } from "./storage-config.mjs";
import { stat } from "node:fs/promises";

export const hashArtifact = async (projectRoot, reference, options) =>
  hashFile((await artifactLocation(projectRoot, reference, options)).path);

export const enqueueCompletedArtifact = async ({
  ledger,
  projectRoot,
  artifactRoot = resolveStorageConfig().artifactRoot,
  artifactRelativePath,
  artifactHash,
  accountId,
  sourceVideoId,
  clipPackageId,
  treatmentId,
  treatmentVersion,
  title,
  caption = "",
}) => {
  const location = await artifactLocation(projectRoot, artifactRelativePath, {
    artifactRoot,
  });
  const relativePath = location.reference;
  const details = await stat(location.path);
  if (!details.isFile() || details.size === 0) {
    throw new Error("artifact must be a non-empty file");
  }
  if (typeof artifactHash !== "string" || artifactHash.trim() === "") {
    throw new Error("artifactHash must be a non-empty string");
  }
  if (location.durable && (await hashFile(location.path)) !== artifactHash)
    throw new Error("Artifact hash does not match completed file");
  return ledger.enqueueArtifact({
    artifactRelativePath: relativePath,
    artifactHash,
    accountId,
    sourceVideoId,
    clipPackageId,
    treatmentId,
    treatmentVersion,
    title,
    caption,
  });
};
