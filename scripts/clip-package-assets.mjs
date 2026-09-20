import { parseSrt } from "@remotion/captions";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { safePathPart } from "./path-components.mjs";

const execFileAsync = promisify(execFile);
const durationToleranceSeconds = 3;

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

const assertNonemptyFile = async (path, role) => {
  const file = await stat(path);
  if (!file.isFile() || file.size === 0) {
    throw new Error(`Generated ${role} asset is empty: ${path}`);
  }
};

const toProjectRelative = (projectRoot, path) =>
  relative(projectRoot, path).split(sep).join("/");

export const acquireClipPackageAssets = async (
  clipPackage,
  { projectRoot = process.cwd(), runCommand = defaultRunCommand } = {},
) => {
  const videoId = safePathPart(clipPackage.videoId, "video ID");
  const packageVersion = safePathPart(
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

  const directory = join(
    projectRoot,
    "public",
    "generated",
    videoId,
    packageVersion,
    `clip-${clipPackage.rank}`,
  );
  await mkdir(directory, { recursive: true });

  const audioTemplate = join(directory, "audio.%(ext)s");
  await runCommand(
    "yt-dlp",
    buildPartialAudioArgs({ ...clipPackage, outputTemplate: audioTemplate }),
  );
  const audioPath = join(directory, "audio.wav");
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
  const expectedDuration = clipPackage.endSeconds - clipPackage.startSeconds;
  if (
    !Number.isFinite(actualDuration) ||
    Math.abs(actualDuration - expectedDuration) > durationToleranceSeconds
  ) {
    throw new Error(
      `Partial audio duration ${actualDuration} does not match expected ${expectedDuration}`,
    );
  }

  const captionTemplate = join(directory, "captions.%(ext)s");
  await runCommand(
    "yt-dlp",
    buildCaptionArgs({
      sourceUrl: clipPackage.sourceUrl,
      outputTemplate: captionTemplate,
      automatic: false,
    }),
  );
  let srtPath = await findGeneratedFile(directory, ".srt");
  let captionsProvenance = "youtube_creator";
  if (!srtPath) {
    await runCommand(
      "yt-dlp",
      buildCaptionArgs({
        sourceUrl: clipPackage.sourceUrl,
        outputTemplate: captionTemplate,
        automatic: true,
      }),
    );
    srtPath = await findGeneratedFile(directory, ".srt");
    captionsProvenance = "youtube_auto";
  }
  if (!srtPath) {
    throw new Error("YouTube captions are unavailable for the selected video");
  }
  await assertNonemptyFile(srtPath, "captions");
  const { captions } = parseSrt({ input: await readFile(srtPath, "utf8") });
  const localCaptions = trimAndRebaseCaptions(
    splitCaptionsIntoTimedWords(captions),
    clipPackage,
  );
  if (localCaptions.length === 0) {
    throw new Error("YouTube captions do not overlap the selected clip");
  }
  const captionsPath = join(directory, "captions.json");
  await writeFile(captionsPath, `${JSON.stringify(localCaptions, null, 2)}\n`);

  const thumbnailTemplate = join(directory, "thumbnail.%(ext)s");
  await runCommand(
    "yt-dlp",
    buildThumbnailArgs({
      sourceUrl: clipPackage.sourceUrl,
      outputTemplate: thumbnailTemplate,
    }),
  );
  const thumbnailPath = await findGeneratedFile(directory, ".jpg");
  if (!thumbnailPath) {
    throw new Error("YouTube thumbnail could not be generated as JPEG");
  }
  await assertNonemptyFile(thumbnailPath, "thumbnail");

  const assets = [
    {
      role: "audio",
      relativePath: toProjectRelative(projectRoot, audioPath),
      provenance: "yt_dlp",
    },
    {
      role: "captions",
      relativePath: toProjectRelative(projectRoot, captionsPath),
      provenance: captionsProvenance,
    },
    {
      role: "thumbnail",
      relativePath: toProjectRelative(projectRoot, thumbnailPath),
      provenance: "yt_dlp",
    },
  ];
  const manifestPath = join(directory, "package.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        packageVersion,
        source: {
          videoId,
          title: clipPackage.title,
          sourceUrl: clipPackage.sourceUrl,
        },
        interval: {
          rank: clipPackage.rank,
          startSeconds: clipPackage.startSeconds,
          endSeconds: clipPackage.endSeconds,
          score: clipPackage.score,
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

  return assets;
};
