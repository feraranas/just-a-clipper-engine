import { parseSrt } from "@remotion/captions";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  canonicalJson,
  deepFreeze,
  sha256Canonical,
} from "./canonical-json.mjs";

const execFileAsync = promisify(execFile);
const maxCanonicalUtf8Bytes = 524_288;

const formatSrtTime = (milliseconds) => {
  const totalMs = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1_000);
  const millis = totalMs % 1_000;
  return String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0") + "," + String(millis).padStart(3, "0");
};

const defaultRunCommand = (command, args) =>
  execFileAsync(command, args, { maxBuffer: 10 * 1024 * 1024 });

const normalizedLanguage = (language) =>
  language.toLowerCase().replaceAll("_", "-");

const compareCodeUnits = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;

const orderedEnglishKeys = (tracks) => {
  if (!tracks || typeof tracks !== "object" || Array.isArray(tracks)) return [];
  const keys = Object.keys(tracks).filter((key) => /^en(?:[-_].+)?$/.test(key));
  const preferred = ["en", "en-orig", "en-US", "en-GB"];
  return [
    ...preferred.filter((key) => keys.includes(key)),
    ...keys
      .filter((key) => !preferred.includes(key))
      .sort(
        (left, right) =>
          compareCodeUnits(
            normalizedLanguage(left),
            normalizedLanguage(right),
          ) || compareCodeUnits(left, right),
      ),
  ];
};

export const selectEnglishCaptionTrack = (metadata) => {
  for (const [field, source] of [
    ["subtitles", "youtube_creator"],
    ["automatic_captions", "youtube_auto"],
  ]) {
    const [language] = orderedEnglishKeys(metadata?.[field]);
    if (language !== undefined) return { source, language };
  }
  throw new Error("English captions are unavailable for the selected video");
};

export const normalizeTranscriptCues = (cues) => {
  if (!Array.isArray(cues) || cues.length === 0) {
    throw new Error("Transcript contains no valid cues");
  }
  const normalized = cues.map((cue, sourceIndex) => {
    const { startMs, endMs } = cue ?? {};
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      startMs < 0 ||
      endMs <= startMs ||
      typeof cue.text !== "string"
    ) {
      throw new Error(`Invalid transcript cue at index ${sourceIndex}`);
    }
    return {
      startMs,
      endMs,
      text: cue.text.replace(/\s+/g, " ").trim(),
      sourceIndex,
    };
  });
  normalized.sort(
    (left, right) =>
      left.startMs - right.startMs ||
      left.endMs - right.endMs ||
      left.sourceIndex - right.sourceIndex,
  );
  return normalized.map(({ sourceIndex: _sourceIndex, ...cue }, index) => ({
    id: `c${String(index + 1).padStart(6, "0")}`,
    ...cue,
  }));
};

export const computeTranscriptIdentity = ({ source, language, cues }) => {
  const canonicalTranscript = { source, language, cues };
  return {
    sha256: sha256Canonical(canonicalTranscript),
    canonicalUtf8Bytes: Buffer.byteLength(
      canonicalJson(canonicalTranscript),
      "utf8",
    ),
  };
};

const metadataArgs = (sourceUrl) => [
  "--no-playlist",
  "--skip-download",
  "--dump-single-json",
  "--",
  sourceUrl,
];

const captionArgs = ({ sourceUrl, outputTemplate, track }) => [
  "--no-playlist",
  "--skip-download",
  track.source === "youtube_creator" ? "--write-subs" : "--write-auto-subs",
  "--sub-langs",
  track.language,
  "--sub-format",
  "srt/best",
  "--convert-subs",
  "srt",
  "--output",
  outputTemplate,
  "--",
  sourceUrl,
];

export const fetchYoutubeTranscript = async (
  sourceUrl,
  { runCommand = defaultRunCommand, tempRoot = tmpdir() } = {},
) => {
  const temporaryDirectory = await mkdtemp(
    join(tempRoot, "youtube-transcript-"),
  );
  try {
    const { stdout } = await runCommand("yt-dlp", metadataArgs(sourceUrl));
    let metadata;
    try {
      metadata = JSON.parse(stdout);
    } catch {
      throw new Error("YouTube caption metadata is not valid JSON");
    }
    const track = selectEnglishCaptionTrack(metadata);
    const outputTemplate = join(temporaryDirectory, "caption.%(ext)s");
    try {
      await runCommand(
        "yt-dlp",
        captionArgs({ sourceUrl, outputTemplate, track }),
      );
    } catch (downloadError) {
      const field = track.source === "youtube_creator" ? "subtitles" : "automatic_captions";
      const trackEntries = Object.entries(metadata?.[field] ?? {});
      const exactTrack = trackEntries.find(([language]) => language === "en-orig") ?? trackEntries.find(([language]) => language === track.language);
      const captionUrl = exactTrack?.[1]?.[0]?.url;
      if (!captionUrl) throw downloadError;
      const response = await fetch(captionUrl);
      if (!response.ok) throw downloadError;
      const json = await response.json();
      const fallbackSrt = (json.events ?? [])
        .filter((event) => Array.isArray(event.segs) && Number.isFinite(event.tStartMs))
        .map((event, index) => {
          const startMs = event.tStartMs;
          const endMs = startMs + (event.dDurationMs ?? 1_000);
          const text = event.segs.map((segment) => segment.utf8 ?? "").join("").trim();
          return (index + 1) + "\n" + formatSrtTime(startMs) + " --> " + formatSrtTime(endMs) + "\n" + text + "\n";
        })
        .join("\n");
      await writeFile(join(temporaryDirectory, "caption.srt"), fallbackSrt);
    }
    const srtFiles = (await readdir(temporaryDirectory))
      .filter((fileName) => fileName.endsWith(".srt"))
      .sort();
    if (srtFiles.length !== 1) {
      throw new Error(
        "YouTube caption download did not produce exactly one SRT file",
      );
    }
    const { captions } = parseSrt({
      input: await readFile(join(temporaryDirectory, srtFiles[0]), "utf8"),
    });
    const cues = normalizeTranscriptCues(captions);
    const identity = computeTranscriptIdentity({ ...track, cues });
    const { canonicalUtf8Bytes } = identity;
    if (canonicalUtf8Bytes > maxCanonicalUtf8Bytes) {
      throw new Error(
        `Canonical transcript is ${canonicalUtf8Bytes} bytes and exceeds the ${maxCanonicalUtf8Bytes} byte limit`,
      );
    }
    return deepFreeze({
      ...track,
      cues,
      ...identity,
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};
