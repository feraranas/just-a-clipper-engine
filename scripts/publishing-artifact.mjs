import { artifactLocation } from "./artifact-store.mjs";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, lstat } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep, extname, join } from "node:path";

export const sameStat = (a, b) =>
  ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
    (key) => a[key] === b[key],
  );
export const hashHandle = async (handle, expected) => {
  const before = await handle.stat({ bigint: true });
  if (
    !before.isFile() ||
    before.size <= 0n ||
    before.size > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error("Invalid file");
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  while (position < Number(before.size)) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, Number(before.size) - position),
      position,
    );
    if (!bytesRead) throw new Error("File changed");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  if (!sameStat(before, after) || `sha256:${hash.digest("hex")}` !== expected)
    throw new Error("Artifact integrity mismatch");
  return after;
};

export const openArtifact = async (projectRoot, item, artifactRoot) => {
  const location = await artifactLocation(
    projectRoot,
    item.artifactRelativePath,
    { artifactRoot },
  );
  const root = location.root;
  const name = item.artifactRelativePath;
  if (
    typeof name !== "string" ||
    isAbsolute(name) ||
    extname(name).toLowerCase() !== ".mp4"
  )
    throw new Error("Invalid artifact path");
  const path = resolve(root, name),
    rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error("Artifact outside root");
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Symlink artifact forbidden");
  }
  if ((await realpath(path)) !== path) throw new Error("Artifact path changed");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await hashHandle(handle, item.approvedArtifactHash);
    if (
      !sameStat(info, await lstat(path, { bigint: true })) ||
      (await realpath(path)) !== path
    )
      throw new Error("Artifact replaced");
    return { handle, info };
  } catch (error) {
    await handle.close();
    throw error;
  }
};

