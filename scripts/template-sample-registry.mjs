import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  resolveTemplateSelection,
  listTemplates,
} from "../src/templates/catalog.mjs";
import { resolveStorageConfig } from "./storage-config.mjs";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.object({
  contractVersion: z.literal(1),
  samples: z.array(
    z.object({
      templateId: z.string(),
      templateVersion: z.string(),
      variationId: z.string(),
      poster: z.string().min(1),
      posterHash: digest,
      videoHash: digest,
      videoUrl: z.string().optional(),
    }),
  ),
});
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const within = (root, target) => {
  const r = relative(root, target);
  return !isAbsolute(r) && r !== ".." && !r.startsWith(".." + sep);
};
export async function resolveSampleRoot({
  sampleRoot,
  projectRoot = process.cwd(),
  environment = process.env,
} = {}) {
  const root =
    sampleRoot ??
    environment.AUDIOGRAM_SAMPLE_ROOT ??
    join(resolveStorageConfig(environment).dataRoot, "template-samples");
  if (!isAbsolute(root))
    throw new Error("AUDIOGRAM_SAMPLE_ROOT must be absolute.");
  const resolved = resolve(root);
  const project = await realpath(projectRoot);
  if (within(project, resolved))
    throw new Error("Sample assets must remain outside the source checkout.");
  // Existing roots must have no symlink components; non-existing roots are allowed for generation.
  let current = resolved;
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("Sample root cannot contain symlinks.");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    try {
      await lstat(join(current, ".git"));
      throw new Error("Sample assets must remain outside source checkouts.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return resolved;
}
async function readRegistered(root, reference) {
  if (
    isAbsolute(reference) ||
    reference.includes("\\") ||
    reference.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Invalid sample asset path.");
  let current = root;
  for (const part of reference.split("/")) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("Sample asset symlinks are not allowed.");
  }
  if ((await realpath(current)) !== current)
    throw new Error("Sample asset escaped its root.");
  const stats = await lstat(current);
  if (!stats.isFile() || stats.size === 0 || stats.size > 10 * 1024 * 1024)
    throw new Error("Invalid sample asset size.");
  return readFile(current);
}
export async function readPoster(entry) {
  const bytes = await readRegistered(entry.root, entry.poster);
  if (sha256(bytes) !== entry.posterHash)
    throw new Error(
      "Sample poster changed. Regenerate or restore the registered sample.",
    );
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8)
    throw new Error("Sample poster must be JPEG.");
  return bytes;
}
export async function loadSampleRegistry(options = {}) {
  const root = await resolveSampleRoot(options);
  const data = schema.parse(
    JSON.parse((await readRegistered(root, "registry.json")).toString()),
  );
  const seen = new Set();
  const entries = [];
  for (const e of data.samples) {
    resolveTemplateSelection({
      templateId: e.templateId,
      templateVersion: e.templateVersion,
      variationId: e.variationId,
    });
    const key = JSON.stringify([
      e.templateId,
      e.templateVersion,
      e.variationId,
    ]);
    if (seen.has(key)) throw new Error("Duplicate sample identity.");
    seen.add(key);
    if (e.videoUrl) {
      const url = new URL(e.videoUrl);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error("Video URL must be HTTPS without credentials.");
      e.videoUrl = url.href;
    }
    const template = listTemplates().find(
      (t) => t.id === e.templateId && t.version === e.templateVersion,
    );
    const entry = {
      ...e,
      root,
      name: template.name,
      description: template.description,
      basePath: `/samples/${e.templateId}/${e.templateVersion}/${e.variationId}/`,
    };
    await readPoster(entry);
    entries.push(entry);
  }
  return entries;
}
