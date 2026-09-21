import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const projectRelative = (projectRoot, artifactRelativePath) => {
  if (typeof artifactRelativePath !== "string" || artifactRelativePath.trim() === "") {
    throw new Error("artifactRelativePath must be a non-empty string");
  }
  if (isAbsolute(artifactRelativePath)) {
    throw new Error("artifact path must be project-relative");
  }
  const root = resolve(projectRoot);
  const absolutePath = resolve(root, artifactRelativePath);
  const relativePath = relative(root, absolutePath);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error("artifact path must stay inside the project repository");
  }
  const normalized = relativePath.split(sep).join("/");
  if (!normalized.toLowerCase().endsWith(".mp4")) {
    throw new Error("artifact path must be an MP4");
  }
  return { absolutePath, relativePath: normalized };
};

export const hashArtifact = async (projectRoot, artifactRelativePath) => {
  const { absolutePath } = projectRelative(projectRoot, artifactRelativePath);
  const details = await stat(absolutePath);
  if (!details.isFile() || details.size === 0) {
    throw new Error("artifact must be a non-empty file");
  }
  const canonicalRoot = await realpath(projectRoot);
  const canonicalArtifact = await realpath(absolutePath);
  const canonicalRelative = relative(canonicalRoot, canonicalArtifact);
  if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${sep}`)) {
    throw new Error("artifact path must resolve inside the project repository");
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(canonicalArtifact)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
};

export const enqueueCompletedArtifact = async ({
  ledger,
  projectRoot,
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
  const { relativePath } = projectRelative(projectRoot, artifactRelativePath);
  const details = await stat(resolve(projectRoot, relativePath));
  if (!details.isFile() || details.size === 0) {
    throw new Error("artifact must be a non-empty file");
  }
  if (typeof artifactHash !== "string" || artifactHash.trim() === "") {
    throw new Error("artifactHash must be a non-empty string");
  }
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
