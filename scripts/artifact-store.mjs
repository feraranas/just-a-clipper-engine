import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveStorageConfig } from "./storage-config.mjs";

const inside = (root, target) => {
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const unavailable = () =>
  Object.assign(
    new Error(
      "Video file is missing or invalid. Restore it from its original checkout or backup, or render it again.",
    ),
    { code: "ARTIFACT_UNAVAILABLE" },
  );
export const hashFile = async (path) => {
  const before = await stat(path, { bigint: true });
  if (!before.isFile() || before.size === 0n) throw unavailable();
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await stat(path, { bigint: true });
  if (
    ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(
      (key) => before[key] !== after[key],
    )
  )
    throw unavailable();
  return `sha256:${hash.digest("hex")}`;
};

export const artifactLocation = async (
  projectRoot,
  reference,
  { artifactRoot = resolveStorageConfig().artifactRoot } = {},
) => {
  if (
    typeof reference !== "string" ||
    isAbsolute(reference) ||
    reference.includes("\\") ||
    reference.split("/").some((p) => !p || p === "." || p === "..") ||
    !reference.endsWith(".mp4")
  )
    throw unavailable();
  const durable = /^artifacts\/[a-f0-9]{64}\/[a-f0-9]{64}\/video\.mp4$/.test(
    reference,
  );
  if (reference.startsWith("artifacts/") && !durable) throw unavailable();
  try {
    const root = await realpath(durable ? artifactRoot : projectRoot);
    const path = resolve(root, reference);
    if (!inside(root, path)) throw unavailable();
    let current = root;
    for (const part of reference.split("/")) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw unavailable();
    }
    if ((await realpath(path)) !== path || !(await stat(path)).isFile())
      throw unavailable();
    if (durable) {
      const [_, videoHash, manifestHash] = reference.split("/");
      if ((await hashFile(path)) !== `sha256:${videoHash}`) throw unavailable();
      const sidecar = join(
        root,
        ...reference.split("/").slice(0, -1),
        "video.manifest.json",
      );
      if ((await lstat(sidecar)).isSymbolicLink()) throw unavailable();
      const bytes = await readFile(sidecar);
      if (createHash("sha256").update(bytes).digest("hex") !== manifestHash)
        throw unavailable();
    }
    return { root, path, reference, durable };
  } catch {
    throw unavailable();
  }
};

const safeDirectory = async (root, parts) => {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const details = await lstat(current);
    if (!details.isDirectory() || details.isSymbolicLink()) throw unavailable();
  }
  return current;
};

export const storeArtifact = async ({
  projectRoot,
  videoPath,
  manifestPath,
  artifactRoot = resolveStorageConfig().artifactRoot,
  expectedHash,
}) => {
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(artifactRoot);
  if (inside(await realpath(projectRoot), root))
    throw new Error(
      "Durable artifact storage must be outside the source checkout",
    );
  const videoHash = await hashFile(videoPath);
  if (expectedHash && expectedHash !== videoHash)
    throw new Error("Artifact hash does not match the saved ledger hash");
  let manifestBytes;
  if (manifestPath) {
    manifestBytes = await readFile(manifestPath);
    const manifest = JSON.parse(manifestBytes);
    if (`sha256:${manifest.artifactHash}` !== videoHash)
      throw new Error("Manifest video hash does not match");
  } else {
    manifestBytes = Buffer.from(
      JSON.stringify({
        manifestVersion: 0,
        artifactHash: videoHash.slice(7),
        inputAssets: null,
        legacyImport: true,
      }) + "\n",
    );
  }
  const manifestHash = createHash("sha256").update(manifestBytes).digest("hex");
  const videoId = videoHash.slice(7);
  const parent = await safeDirectory(root, ["artifacts", videoId]);
  const target = join(parent, manifestHash);
  const temporary = join(parent, `.pending-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    await copyFile(videoPath, join(temporary, "video.mp4"));
    await writeFile(join(temporary, "video.manifest.json"), manifestBytes, {
      mode: 0o600,
    });
    if (
      (await hashFile(join(temporary, "video.mp4"))) !== videoHash ||
      (await hashFile(videoPath)) !== videoHash
    )
      throw new Error("Artifact changed during durable copy");
    const verify = async () => {
      const location = await artifactLocation(
        projectRoot,
        `artifacts/${videoId}/${manifestHash}/video.mp4`,
        { artifactRoot: root },
      );
      if ((await hashFile(location.path)) !== videoHash)
        throw new Error("Existing artifact bundle has different bytes");
      const sidecar = join(target, "video.manifest.json");
      if (
        (await lstat(sidecar)).isSymbolicLink() ||
        !(await readFile(sidecar)).equals(manifestBytes)
      )
        throw new Error("Existing artifact manifest has different bytes");
    };
    try {
      await rename(temporary, target);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
    }
    await verify();
    return `artifacts/${videoId}/${manifestHash}/video.mp4`;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};
