import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolveTemplateSelection, listTemplates } from "../src/templates/catalog.mjs";
import { execFile } from "node:child_process";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
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

export const renderTreatmentRun = async (
  { clipPackage, treatment, selection },
  { projectRoot = process.cwd(), runCommand = defaultRunCommand } = {},
) => {
  const known = listTemplates().flatMap(template => template.variations.map(variation => ({template, variation})))
    .find(({variation}) => variation.treatment.id === treatment.id && variation.treatment.version === treatment.version);
  const resolved = selection === undefined ? (known ? resolveTemplateSelection({templateId: known.template.id, templateVersion: known.template.version, variationId: known.variation.id}) : null) : resolveTemplateSelection(selection);
  if (resolved && (resolved.treatment.id !== treatment.id || resolved.treatment.version !== treatment.version || resolved.compositionId !== treatment.compositionId)) {
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
  const manifestPath = join(outputDirectory, `${baseName}.manifest.json`);
  const manifestPartialPath = join(outputDirectory, `.${baseName}.manifest.partial.json`);
  const manifest = {manifestVersion: 1, selection: resolved?.selection ?? null,
    treatment: {id: treatment.id, version: treatment.version}, compositionId: treatment.compositionId,
    props, artifactHash: createHash("sha256").update(await readFile(partialPath)).digest("hex")};
  await writeFile(manifestPartialPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(manifestPartialPath, manifestPath);
  await rename(partialPath, outputPath);
  return toProjectRelative(projectRoot, outputPath);
};
