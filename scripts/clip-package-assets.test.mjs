import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {
  acquireClipPackageAssets,
  buildPartialAudioArgs,
  trimAndRebaseCaptions,
} from "./clip-package-assets.mjs";

test("partial audio arguments request only the selected time range", () => {
  const args = buildPartialAudioArgs({
    sourceUrl: "https://youtu.be/video-1",
    startSeconds: 12.5,
    endSeconds: 42.25,
    outputTemplate: "/tmp/audio.%(ext)s",
  });

  assert.ok(args.includes("--no-playlist"));
  assert.deepEqual(
    args.slice(args.indexOf("--download-sections"), args.indexOf("--download-sections") + 2),
    ["--download-sections", "*12.5-42.25"],
  );
  assert.ok(args.includes("--extract-audio"));
  assert.deepEqual(args.slice(args.indexOf("--audio-format"), args.indexOf("--audio-format") + 2), ["--audio-format", "wav"]);
});

test("captions are clipped to the selection and rebased to local time", () => {
  const captions = trimAndRebaseCaptions(
    [
      {text: "before", startMs: 8_000, endMs: 12_000, timestampMs: 10_000, confidence: 1},
      {text: "inside", startMs: 15_000, endMs: 20_000, timestampMs: 17_500, confidence: 1},
      {text: "after", startMs: 30_000, endMs: 35_000, timestampMs: 32_500, confidence: 1},
    ],
    {startSeconds: 10, endSeconds: 30},
  );

  assert.deepEqual(captions, [
    {text: "before", startMs: 0, endMs: 2_000, timestampMs: 0, confidence: 1},
    {text: "inside", startMs: 5_000, endMs: 10_000, timestampMs: 7_500, confidence: 1},
  ]);
});

test("acquires audio, manual captions, and thumbnail into a deterministic package", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "clip-package-assets-"));
  t.after(() => rm(projectRoot, {recursive: true, force: true}));
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push({command, args});
    const outputTemplate = args[args.indexOf("--output") + 1];
    await mkdir(join(projectRoot, "public/generated/video-1/v1/clip-2"), {recursive: true});
    if (command === "yt-dlp" && args.includes("--extract-audio")) {
      await writeFile(outputTemplate.replace("%(ext)s", "wav"), "audio");
    } else if (command === "yt-dlp" && args.includes("--write-subs")) {
      await writeFile(
        outputTemplate.replace("%(ext)s", "en.srt"),
        "1\n00:00:10,000 --> 00:00:15,000\nHello world\n",
      );
    } else if (command === "yt-dlp" && args.includes("--write-thumbnail")) {
      await writeFile(outputTemplate.replace("%(ext)s", "jpg"), "image");
    } else if (command === "ffprobe") {
      return {stdout: "20.0\n"};
    }
    return {stdout: ""};
  };

  const assets = await acquireClipPackageAssets(
    {
      videoId: "video-1",
      title: "A useful video",
      packageVersion: "v1",
      rank: 2,
      sourceUrl: "https://youtu.be/video-1",
      startSeconds: 10,
      endSeconds: 30,
      score: 0.9,
    },
    {projectRoot, runCommand},
  );

  assert.deepEqual(assets, [
    {role: "audio", relativePath: "public/generated/video-1/v1/clip-2/audio.wav", provenance: "yt_dlp"},
    {role: "captions", relativePath: "public/generated/video-1/v1/clip-2/captions.json", provenance: "youtube_creator"},
    {role: "thumbnail", relativePath: "public/generated/video-1/v1/clip-2/thumbnail.jpg", provenance: "yt_dlp"},
  ]);
  assert.equal(
    calls.filter(({args}) => args.includes("--write-auto-subs")).length,
    0,
  );
  const captionCall = calls.find(({args}) => args.includes("--write-subs"));
  assert.deepEqual(
    captionCall.args.slice(
      captionCall.args.indexOf("--convert-subs"),
      captionCall.args.indexOf("--convert-subs") + 2,
    ),
    ["--convert-subs", "srt"],
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(projectRoot, "public/generated/video-1/v1/clip-2/captions.json"),
        "utf8",
      ),
    ),
    [{text: "Hello world", startMs: 0, endMs: 5_000, timestampMs: 2_500, confidence: 1}],
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(projectRoot, "public/generated/video-1/v1/clip-2/package.json"),
        "utf8",
      ),
    ),
    {
      schemaVersion: 1,
      packageVersion: "v1",
      source: {
        videoId: "video-1",
        title: "A useful video",
        sourceUrl: "https://youtu.be/video-1",
      },
      interval: {
        rank: 2,
        startSeconds: 10,
        endSeconds: 30,
        score: 0.9,
      },
      assets: [
        {role: "audio", fileName: "audio.wav", provenance: "yt_dlp"},
        {role: "captions", fileName: "captions.json", provenance: "youtube_creator"},
        {role: "thumbnail", fileName: "thumbnail.jpg", provenance: "yt_dlp"},
      ],
    },
  );
});

test("falls back to automatic captions when creator captions are unavailable", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "clip-package-assets-"));
  t.after(() => rm(projectRoot, {recursive: true, force: true}));
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push({command, args});
    const outputTemplate = args[args.indexOf("--output") + 1];
    if (command === "ffprobe") return {stdout: "20\n"};
    if (args.includes("--extract-audio")) {
      await writeFile(outputTemplate.replace("%(ext)s", "wav"), "audio");
    } else if (args.includes("--write-auto-subs")) {
      await writeFile(
        outputTemplate.replace("%(ext)s", "en.srt"),
        "1\n00:00:10,000 --> 00:00:15,000\nAutomatic caption\n",
      );
    } else if (args.includes("--write-thumbnail")) {
      await writeFile(outputTemplate.replace("%(ext)s", "jpg"), "image");
    }
    return {stdout: ""};
  };

  const assets = await acquireClipPackageAssets(
    {
      videoId: "video-2",
      title: "Automatic captions",
      packageVersion: "v1",
      rank: 1,
      sourceUrl: "https://youtu.be/video-2",
      startSeconds: 10,
      endSeconds: 30,
      score: 1,
    },
    {projectRoot, runCommand},
  );

  assert.equal(calls.filter(({args}) => args.includes("--write-subs")).length, 1);
  assert.equal(
    calls.filter(({args}) => args.includes("--write-auto-subs")).length,
    1,
  );
  assert.equal(
    assets.find(({role}) => role === "captions").provenance,
    "youtube_auto",
  );
});
