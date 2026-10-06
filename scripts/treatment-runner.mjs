import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import {
  resolveTemplateSelection,
  listTemplates,
} from "../src/templates/catalog.mjs";
import { execFile } from "node:child_process";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { safePathPart } from "./path-components.mjs";
import { assertRequiredAssets } from "./treatment-registry.mjs";

const execFileAsync = promisify(execFile);

const defaultRunCommand = async (command, args, { cwd }) =>
  execFileAsync(command, args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });

const toProjectRelative = (projectRoot, path) =>
  relative(projectRoot, path).split(sep).join("/");

const insideRoot = (root, target) => {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

const hashInputAssets = async (projectRoot, assets) => {
  const canonicalRoot = await realpath(projectRoot);
  return Promise.all(
    assets.map(async ({ role, relativePath }) => {
      try {
        if (
          typeof relativePath !== "string" ||
          isAbsolute(relativePath) ||
          !insideRoot(projectRoot, resolve(projectRoot, relativePath))
        ) {
          throw new Error("path is outside the project");
        }
        const filePath = resolve(projectRoot, relativePath);
        if (!insideRoot(canonicalRoot, await realpath(filePath))) {
          throw new Error("file is outside the project");
        }
        if (!(await stat(filePath)).isFile())
          throw new Error("not a regular file");
        const hash = createHash("sha256");
        let sizeBytes = 0;
        for await (const chunk of createReadStream(filePath)) {
          hash.update(chunk);
          sizeBytes += chunk.length;
        }
        return {
          role,
          relativePath: toProjectRelative(projectRoot, filePath),
          sizeBytes,
          sha256: hash.digest("hex"),
        };
      } catch {
        throw new Error(
          `Input asset ${role} is missing, unreadable or outside the project`,
        );
      }
    }),
  );
};

export const renderTreatmentRun = async (
  { clipPackage, treatment, selection },
  { projectRoot = process.cwd(), runCommand = defaultRunCommand } = {},
) => {
  const known = listTemplates()
    .flatMap((template) =>
      template.variations.map((variation) => ({ template, variation })),
    )
    .find(
      ({ variation }) =>
        variation.treatment.id === treatment.id &&
        variation.treatment.version === treatment.version,
    );
  const resolved =
    selection === undefined
      ? known
        ? resolveTemplateSelection({
            templateId: known.template.id,
            templateVersion: known.template.version,
            variationId: known.variation.id,
          })
        : null
      : resolveTemplateSelection(selection);
  if (
    resolved &&
    (resolved.treatment.id !== treatment.id ||
      resolved.treatment.version !== treatment.version ||
      resolved.compositionId !== treatment.compositionId)
  ) {
    throw new Error("Selection does not match the render treatment");
  }
  const treatmentId = safePathPart(treatment.id, "treatment ID");
  const treatmentVersion = safePathPart(treatment.version, "treatment version");
  const videoId = safePathPart(clipPackage.videoId, "video ID");
  if (clipPackage.packageVersion == null) {
    throw new Error(`Invalid package version: ${clipPackage.packageVersion}`);
  }
  const packageVersion = safePathPart(
    clipPackage.packageVersion,
    "package version",
  );
  if (!Number.isInteger(clipPackage.rank) || clipPackage.rank < 1) {
    throw new Error(`Invalid package rank: ${clipPackage.rank}`);
  }
  assertRequiredAssets(treatment, clipPackage);
  const requiredAssets = treatment.requiredAssetRoles.map((role) => {
    const matches = (clipPackage.assets ?? []).filter(
      (asset) => asset.role === role,
    );
    if (matches.length !== 1)
      throw new Error(`Input asset ${role} must have exactly one path`);
    return { role, relativePath: matches[0].relativePath };
  });
  const inputAssets = await hashInputAssets(projectRoot, requiredAssets);

  const outputDirectory = join(
    projectRoot,
    "out",
    "treatments",
    treatmentId,
    treatmentVersion,
    videoId,
    packageVersion,
  );
  await mkdir(outputDirectory, { recursive: true });
  const baseName = `clip-${clipPackage.rank}`;
  const propsPath = join(outputDirectory, `${baseName}.props.json`);
  const outputPath = join(
    outputDirectory,
    `${baseName}.${treatment.output.extension}`,
  );
  const partialPath = join(
    outputDirectory,
    `.${baseName}.partial.${treatment.output.extension}`,
  );
  const props = treatment.buildProps(clipPackage);
  await writeFile(propsPath, `${JSON.stringify(props, null, 2)}\n`);

  await runCommand(
    "npx",
    [
      "remotion",
      "render",
      treatment.compositionId,
      partialPath,
      `--props=${propsPath}`,
      `--codec=${treatment.output.codec}`,
    ],
    { cwd: projectRoot },
  );
  const rendered = await stat(partialPath);
  if (!rendered.isFile() || rendered.size === 0) {
    throw new Error(`Rendered artifact is empty: ${partialPath}`);
  }
  const checkedInputs = await hashInputAssets(projectRoot, requiredAssets);
  if (JSON.stringify(checkedInputs) !== JSON.stringify(inputAssets)) {
    throw new Error("Input asset contents changed during rendering");
  }
  const manifestPath = join(outputDirectory, `${baseName}.manifest.json`);
  const manifestPartialPath = join(
    outputDirectory,
    `.${baseName}.manifest.partial.json`,
  );
  const manifest = {
    manifestVersion: 2,
    inputAssets,
    selection: resolved?.selection ?? null,
    treatment: { id: treatment.id, version: treatment.version },
    compositionId: treatment.compositionId,
    props,
    artifactHash: createHash("sha256")
      .update(await readFile(partialPath))
      .digest("hex"),
  };
  await writeFile(
    manifestPartialPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await rename(manifestPartialPath, manifestPath);
  await rename(partialPath, outputPath);
  return toProjectRelative(projectRoot, outputPath);
};
