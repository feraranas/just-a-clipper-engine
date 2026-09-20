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
  { clipPackage, treatment },
  { projectRoot = process.cwd(), runCommand = defaultRunCommand } = {},
) => {
  const treatmentId = safePathPart(treatment.id, "treatment ID");
  const treatmentVersion = safePathPart(treatment.version, "treatment version");
  const videoId = safePathPart(clipPackage.videoId, "video ID");
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
  await writeFile(
    propsPath,
    `${JSON.stringify(treatment.buildProps(clipPackage), null, 2)}\n`,
  );

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
  await rename(partialPath, outputPath);
  return toProjectRelative(projectRoot, outputPath);
};
