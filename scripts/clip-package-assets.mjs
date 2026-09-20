import { parseSrt } from "@remotion/captions";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { safePathPart } from "./path-components.mjs";

const execFileAsync = promisify(execFile);
const durationToleranceSeconds = 3;
const packageSchemaVersion = 1;
const assetDefinitions = {
  audio: { fileName: "audio.wav", provenances: ["yt_dlp"] },
  captions: {
    fileName: "captions.json",
    provenances: ["youtube_creator", "youtube_auto"],
  },
  thumbnail: { fileName: "thumbnail.jpg", provenances: ["yt_dlp"] },
};
const assetRoles = Object.keys(assetDefinitions);

const defaultRunCommand = async (command, args) =>
  execFileAsync(command, args, { maxBuffer: 10 * 1024 * 1024 });

export const buildPartialAudioArgs = ({
  sourceUrl,
  startSeconds,
  endSeconds,
  outputTemplate,
}) => [
  "--no-playlist",
  "--download-sections",
  `*${startSeconds}-${endSeconds}`,
  "--extract-audio",
  "--audio-format",
  "wav",
  "--output",
  outputTemplate,
  sourceUrl,
];

const buildCaptionArgs = ({ sourceUrl, outputTemplate, automatic }) => [
  "--no-playlist",
  "--skip-download",
  automatic ? "--write-auto-subs" : "--write-subs",
  "--sub-langs",
  "en.*,en",
  "--sub-format",
  "srt/best",
  "--convert-subs",
  "srt",
  "--output",
  outputTemplate,
  sourceUrl,
];

const buildThumbnailArgs = ({ sourceUrl, outputTemplate }) => [
  "--no-playlist",
  "--skip-download",
  "--write-thumbnail",
  "--convert-thumbnails",
  "jpg",
  "--output",
  outputTemplate,
  sourceUrl,
];

export const splitCaptionsIntoTimedWords = (captions) => {
  let hasEmittedWord = false;
  return captions.flatMap((caption) => {
    const words = caption.text
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean);
    if (words.length === 0) return [];
    const wordDuration = (caption.endMs - caption.startMs) / words.length;

    return words.map((word, index) => {
      const isLastWord = index === words.length - 1;
      const startMs = caption.startMs + wordDuration * index;
      const endMs = isLastWord
        ? caption.endMs
        : caption.startMs + wordDuration * (index + 1);
      const text = `${hasEmittedWord ? " " : ""}${word}`;
      hasEmittedWord = true;
      return {
        text,
        startMs,
        endMs,
        timestampMs: startMs + (endMs - startMs) / 2,
        confidence: caption.confidence,
        ...(isLastWord && caption.pageBreakAfter
          ? { pageBreakAfter: true }
          : {}),
      };
    });
  });
};

export const trimAndRebaseCaptions = (
  captions,
  { startSeconds, endSeconds },
) => {
  const selectionStartMs = startSeconds * 1_000;
  const selectionEndMs = endSeconds * 1_000;
  return captions
    .filter(
      (caption) =>
        caption.endMs > selectionStartMs && caption.startMs < selectionEndMs,
    )
    .map((caption) => {
      const startMs = Math.max(caption.startMs, selectionStartMs);
      const endMs = Math.min(caption.endMs, selectionEndMs);
      const timestampMs = Math.min(
        endMs,
        Math.max(startMs, caption.timestampMs),
      );
      return {
        ...caption,
        startMs: startMs - selectionStartMs,
        endMs: endMs - selectionStartMs,
        timestampMs: timestampMs - selectionStartMs,
      };
    });
};

const findGeneratedFile = async (directory, suffix) => {
  const fileNames = (await readdir(directory))
    .filter((fileName) => fileName.endsWith(suffix))
    .sort();
  return fileNames.length > 0 ? join(directory, fileNames[0]) : null;
};

const removeGeneratedFiles = async (directory, suffix) => {
  const fileNames = (await readdir(directory)).filter((fileName) =>
    fileName.endsWith(suffix),
  );
  await Promise.all(
    fileNames.map((fileName) => unlink(join(directory, fileName))),
  );
};

const assertNonemptyFile = async (path, role) => {
  let file;
  try {
    file = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Generated ${role} asset is missing: ${path}`);
    }
    throw error;
  }
  if (file.isSymbolicLink() || !file.isFile() || file.size === 0) {
    throw new Error(`Generated ${role} asset is empty: ${path}`);
  }
};

const toProjectRelative = (projectRoot, path) =>
  relative(projectRoot, path).split(sep).join("/");

const requiredPathPart = (value, label) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return safePathPart(value, label);
};

const validateClipPackageIdentity = (clipPackage) => {
  const videoId = requiredPathPart(clipPackage.videoId, "video ID");
  const packageVersion = requiredPathPart(
    clipPackage.packageVersion,
    "package version",
  );
  if (!Number.isInteger(clipPackage.rank) || clipPackage.rank < 1) {
    throw new Error(`Invalid package rank: ${clipPackage.rank}`);
  }
  if (
    !Number.isFinite(clipPackage.startSeconds) ||
    !Number.isFinite(clipPackage.endSeconds) ||
    clipPackage.startSeconds < 0 ||
    clipPackage.endSeconds <= clipPackage.startSeconds
  ) {
    throw new Error("Invalid package time range");
  }
  if (!Number.isFinite(clipPackage.score)) {
    throw new Error(`Invalid package score: ${clipPackage.score}`);
  }
  return { ...clipPackage, videoId, packageVersion };
};

export const getClipPackagePaths = (
  clipPackage,
  { projectRoot = process.cwd(), stagingId } = {},
) => {
  const validatedPackage = validateClipPackageIdentity(clipPackage);
  const parentDirectory = join(
    projectRoot,
    "public",
    "generated",
    validatedPackage.videoId,
    validatedPackage.packageVersion,
  );
  const finalDirectory = join(parentDirectory, `clip-${validatedPackage.rank}`);
  const stagingDirectory =
    stagingId === undefined
      ? undefined
      : join(
          parentDirectory,
          `.clip-${validatedPackage.rank}.staging-${requiredPathPart(
            stagingId,
            "staging ID",
          )}`,
        );
  return { parentDirectory, finalDirectory, stagingDirectory };
};

const invalidPackage = (projectRoot, directory, kind, reason) => {
  const packagePath = toProjectRelative(projectRoot, directory).slice(0, 160);
  return new Error(`Invalid ${kind} clip package at ${packagePath}: ${reason}`);
};

const invalidManagedPath = (projectRoot, path, reason) => {
  const managedPath = toProjectRelative(projectRoot, path).slice(0, 160);
  return new Error(
    `Invalid managed clip package path at ${managedPath}: ${reason}`,
  );
};

const validateManagedAncestorDirectories = async (clipPackage, projectRoot) => {
  const managedDirectories = [
    join(projectRoot, "public"),
    join(projectRoot, "public", "generated"),
    join(projectRoot, "public", "generated", clipPackage.videoId),
    join(
      projectRoot,
      "public",
      "generated",
      clipPackage.videoId,
      clipPackage.packageVersion,
    ),
  ];
  for (const directory of managedDirectories) {
    let entry;
    try {
      entry = await lstat(directory);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (entry.isSymbolicLink()) {
      throw invalidManagedPath(projectRoot, directory, "symbolic link");
    }
    if (!entry.isDirectory()) {
      throw invalidManagedPath(projectRoot, directory, "not a directory");
    }
  }
};

const sameNumber = (actual, expected) =>
  typeof actual === "number" && Object.is(actual, expected);

const readAndValidateManifest = async (
  directory,
  clipPackage,
  { projectRoot, kind },
) => {
  const manifestPath = join(directory, "package.json");
  try {
    const manifestFile = await lstat(manifestPath);
    if (manifestFile.isSymbolicLink()) {
      throw invalidPackage(
        projectRoot,
        directory,
        kind,
        "package.json must not be a symbolic link",
      );
    }
    if (!manifestFile.isFile() || manifestFile.size === 0) {
      throw invalidPackage(
        projectRoot,
        directory,
        kind,
        "package.json must be a non-empty file",
      );
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw invalidPackage(
        projectRoot,
        directory,
        kind,
        "missing package.json",
      );
    }
    throw error;
  }
  let manifestText;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch (error) {
    throw invalidPackage(
      projectRoot,
      directory,
      kind,
      "unreadable package.json",
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw invalidPackage(
      projectRoot,
      directory,
      kind,
      "malformed package.json",
    );
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw invalidPackage(
      projectRoot,
      directory,
      kind,
      "manifest must be an object",
    );
  }
  if (manifest.schemaVersion !== packageSchemaVersion) {
    throw invalidPackage(
      projectRoot,
      directory,
      kind,
      "schema version mismatch",
    );
  }
  if (manifest.packageVersion !== clipPackage.packageVersion) {
    throw invalidPackage(
      projectRoot,
      directory,
      kind,
      "package version mismatch",
    );
  }
  if (
    !manifest.source ||
    typeof manifest.source !== "object" ||
    manifest.source.videoId !== clipPackage.videoId
  ) {
    throw invalidPackage(
      projectRoot,
      directory,
      kind,
      "video identity mismatch",
    );
  }
  const interval = manifest.interval;
  if (
    !interval ||
    typeof interval !== "object" ||
    interval.rank !== clipPackage.rank ||
    !sameNumber(interval.startSeconds, clipPackage.startSeconds) ||
    !sameNumber(interval.endSeconds, clipPackage.endSeconds) ||
    !sameNumber(interval.score, clipPackage.score)
  ) {
    throw invalidPackage(
      projectRoot,
      directory,
      kind,
      "interval identity mismatch",
    );
  }
  if (
    !Array.isArray(manifest.assets) ||
    manifest.assets.length !== assetRoles.length
  ) {
    throw invalidPackage(
      projectRoot,
      directory,
      kind,
      "asset manifest mismatch",
    );
  }

  const recordsByRole = new Map();
  for (const asset of manifest.assets) {
    if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
      throw invalidPackage(
        projectRoot,
        directory,
        kind,
        "invalid asset descriptor",
      );
    }
    const keys = Object.keys(asset).sort();
    if (keys.join(",") !== "fileName,provenance,role") {
      throw invalidPackage(
        projectRoot,
        directory,
        kind,
        "invalid asset descriptor shape",
      );
    }
    const definition = assetDefinitions[asset.role];
    if (!definition || recordsByRole.has(asset.role)) {
      throw invalidPackage(
        projectRoot,
        directory,
        kind,
        "unexpected asset role",
      );
    }
    if (
      asset.fileName !== definition.fileName ||
      !definition.provenances.includes(asset.provenance)
    ) {
      throw invalidPackage(
        projectRoot,
        directory,
        kind,
        "asset descriptor mismatch",
      );
    }
    recordsByRole.set(asset.role, asset);
  }
  if (assetRoles.some((role) => !recordsByRole.has(role))) {
    throw invalidPackage(projectRoot, directory, kind, "missing asset role");
  }

  for (const role of assetRoles) {
    const { fileName } = assetDefinitions[role];
    try {
      const file = await lstat(join(directory, fileName));
      if (file.isSymbolicLink()) {
        throw invalidPackage(
          projectRoot,
          directory,
          kind,
          `${role} asset must not be a symbolic link`,
        );
      }
      if (!file.isFile() || file.size === 0) {
        throw invalidPackage(
          projectRoot,
          directory,
          kind,
          `${role} asset is empty`,
        );
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw invalidPackage(
          projectRoot,
          directory,
          kind,
          `${role} asset is missing`,
        );
      }
      throw error;
    }
  }

  const captionPath = join(directory, assetDefinitions.captions.fileName);
  try {
    const captions = JSON.parse(await readFile(captionPath, "utf8"));
    if (!Array.isArray(captions) || captions.length === 0) {
      throw new Error("not a non-empty array");
    }
  } catch {
    throw invalidPackage(
      projectRoot,
      directory,
      kind,
      "captions asset is malformed",
    );
  }

  return recordsByRole;
};

const assetsAtDirectory = (projectRoot, directory, recordsByRole) =>
  assetRoles.map((role) => ({
    role,
    relativePath: toProjectRelative(
      projectRoot,
      join(directory, assetDefinitions[role].fileName),
    ),
    provenance: recordsByRole.get(role).provenance,
  }));

const inspectClipPackageDirectory = async (
  clipPackage,
  directory,
  { projectRoot, kind },
) => {
  const recordsByRole = await readAndValidateManifest(directory, clipPackage, {
    projectRoot,
    kind,
  });
  return { assets: assetsAtDirectory(projectRoot, directory, recordsByRole) };
};

export const inspectPublishedClipPackage = async (
  clipPackage,
  { projectRoot = process.cwd() } = {},
) => {
  const validatedPackage = validateClipPackageIdentity(clipPackage);
  const { finalDirectory } = getClipPackagePaths(validatedPackage, {
    projectRoot,
  });
  await validateManagedAncestorDirectories(validatedPackage, projectRoot);
  try {
    const directory = await lstat(finalDirectory);
    if (directory.isSymbolicLink()) {
      throw invalidPackage(
        projectRoot,
        finalDirectory,
        "published",
        "final path must not be a symbolic link",
      );
    }
    if (!directory.isDirectory()) {
      throw invalidPackage(
        projectRoot,
        finalDirectory,
        "published",
        "final path is not a directory",
      );
    }
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return inspectClipPackageDirectory(validatedPackage, finalDirectory, {
    projectRoot,
    kind: "published",
  });
};

export const acquireClipPackageAssets = async (
  clipPackage,
  {
    projectRoot = process.cwd(),
    runCommand = defaultRunCommand,
    createStagingId = randomUUID,
  } = {},
) => {
  const validatedPackage = validateClipPackageIdentity(clipPackage);
  const published = await inspectPublishedClipPackage(validatedPackage, {
    projectRoot,
  });
  if (published) return published.assets;

  const stagingId = requiredPathPart(createStagingId(), "staging ID");
  const paths = getClipPackagePaths(validatedPackage, {
    projectRoot,
    stagingId,
  });
  let ownsStagingDirectory = false;
  try {
    await mkdir(paths.parentDirectory, { recursive: true });
    await mkdir(paths.stagingDirectory);
    ownsStagingDirectory = true;

    const audioTemplate = join(paths.stagingDirectory, "audio.%(ext)s");
    await runCommand(
      "yt-dlp",
      buildPartialAudioArgs({
        ...validatedPackage,
        outputTemplate: audioTemplate,
      }),
    );
    const audioPath = join(paths.stagingDirectory, "audio.wav");
    await assertNonemptyFile(audioPath, "audio");
    const { stdout: durationOutput } = await runCommand("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      audioPath,
    ]);
    const actualDuration = Number.parseFloat(durationOutput);
    const expectedDuration =
      validatedPackage.endSeconds - validatedPackage.startSeconds;
    if (
      !Number.isFinite(actualDuration) ||
      Math.abs(actualDuration - expectedDuration) > durationToleranceSeconds
    ) {
      throw new Error(
        `Partial audio duration ${actualDuration} does not match expected ${expectedDuration}`,
      );
    }

    const captionTemplate = join(paths.stagingDirectory, "captions.%(ext)s");
    await runCommand(
      "yt-dlp",
      buildCaptionArgs({
        sourceUrl: validatedPackage.sourceUrl,
        outputTemplate: captionTemplate,
        automatic: false,
      }),
    );
    let srtPath = await findGeneratedFile(paths.stagingDirectory, ".srt");
    let captionsProvenance = "youtube_creator";
    if (!srtPath) {
      await runCommand(
        "yt-dlp",
        buildCaptionArgs({
          sourceUrl: validatedPackage.sourceUrl,
          outputTemplate: captionTemplate,
          automatic: true,
        }),
      );
      srtPath = await findGeneratedFile(paths.stagingDirectory, ".srt");
      captionsProvenance = "youtube_auto";
    }
    if (!srtPath) {
      throw new Error(
        "YouTube captions are unavailable for the selected video",
      );
    }
    await assertNonemptyFile(srtPath, "captions");
    const { captions } = parseSrt({ input: await readFile(srtPath, "utf8") });
    const localCaptions = trimAndRebaseCaptions(
      splitCaptionsIntoTimedWords(captions),
      validatedPackage,
    );
    if (localCaptions.length === 0) {
      throw new Error("YouTube captions do not overlap the selected clip");
    }
    const captionsPath = join(paths.stagingDirectory, "captions.json");
    await writeFile(
      captionsPath,
      `${JSON.stringify(localCaptions, null, 2)}\n`,
    );
    await removeGeneratedFiles(paths.stagingDirectory, ".srt");

    const thumbnailTemplate = join(paths.stagingDirectory, "thumbnail.%(ext)s");
    await runCommand(
      "yt-dlp",
      buildThumbnailArgs({
        sourceUrl: validatedPackage.sourceUrl,
        outputTemplate: thumbnailTemplate,
      }),
    );
    const thumbnailPath = await findGeneratedFile(
      paths.stagingDirectory,
      ".jpg",
    );
    if (!thumbnailPath) {
      throw new Error("YouTube thumbnail could not be generated as JPEG");
    }
    await assertNonemptyFile(thumbnailPath, "thumbnail");

    const manifestPath = join(paths.stagingDirectory, "package.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          schemaVersion: packageSchemaVersion,
          packageVersion: validatedPackage.packageVersion,
          source: {
            videoId: validatedPackage.videoId,
            title: validatedPackage.title,
            sourceUrl: validatedPackage.sourceUrl,
          },
          interval: {
            rank: validatedPackage.rank,
            startSeconds: validatedPackage.startSeconds,
            endSeconds: validatedPackage.endSeconds,
            score: validatedPackage.score,
          },
          assets: [
            { role: "audio", fileName: "audio.wav", provenance: "yt_dlp" },
            {
              role: "captions",
              fileName: "captions.json",
              provenance: captionsProvenance,
            },
            {
              role: "thumbnail",
              fileName: "thumbnail.jpg",
              provenance: "yt_dlp",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await assertNonemptyFile(manifestPath, "package manifest");

    const staged = await inspectClipPackageDirectory(
      validatedPackage,
      paths.stagingDirectory,
      { projectRoot, kind: "staged" },
    );
    try {
      await rename(paths.stagingDirectory, paths.finalDirectory);
      ownsStagingDirectory = false;
      return staged.assets.map(({ role, provenance }) => ({
        role,
        relativePath: toProjectRelative(
          projectRoot,
          join(paths.finalDirectory, assetDefinitions[role].fileName),
        ),
        provenance,
      }));
    } catch (promotionError) {
      const winner = await inspectPublishedClipPackage(validatedPackage, {
        projectRoot,
      });
      if (winner) return winner.assets;
      throw promotionError;
    }
  } finally {
    if (ownsStagingDirectory) {
      await rm(paths.stagingDirectory, { recursive: true, force: true });
    }
  }
};
