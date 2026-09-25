import assert from "node:assert/strict";
import { parseSrt } from "@remotion/captions";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import * as clipPackageAssets from "./clip-package-assets.mjs";
import {
  acquireClipPackageAssets,
  buildPartialAudioArgs,
  splitCaptionsIntoTimedWords,
  trimAndRebaseCaptions,
} from "./clip-package-assets.mjs";
import { computeTranscriptIdentity } from "./youtube-transcript-core.mjs";

const exampleTranscript = (overrides = {}) => {
  const transcript = {
    id: 17,
    source: "youtube_creator",
    language: "en",
    cues: [
      { id: "c000001", startMs: 10_000, endMs: 20_000, text: "Hello world" },
      {
        id: "c000002",
        startMs: 20_000,
        endMs: 30_000,
        text: "Persisted transcript",
      },
    ],
    ...overrides,
  };
  return { ...transcript, ...computeTranscriptIdentity(transcript) };
};

const exampleClipPackage = (overrides = {}) => ({
  videoId: "video-1",
  title: "A useful video",
  packageVersion: "v1",
  rank: 2,
  sourceUrl: "https://youtu.be/video-1",
  startSeconds: 10,
  endSeconds: 30,
  score: 0.9,
  ...overrides,
});

const packageManifest = (clipPackage, overrides = {}) => {
  const transcript = clipPackage.transcript;
  return {
    schemaVersion: 1,
    packageVersion: clipPackage.packageVersion,
    source: {
      videoId: clipPackage.videoId,
      title: clipPackage.title,
      sourceUrl: clipPackage.sourceUrl,
    },
    interval: {
      rank: clipPackage.rank,
      startSeconds: clipPackage.startSeconds,
      endSeconds: clipPackage.endSeconds,
      score: clipPackage.score,
    },
    ...(transcript
      ? {
          transcript: {
            id: transcript.id,
            sha256: transcript.sha256,
            source: transcript.source,
            language: transcript.language,
          },
        }
      : {}),
    assets: [
      { role: "audio", fileName: "audio.wav", provenance: "yt_dlp" },
      {
        role: "captions",
        fileName: "captions.json",
        provenance: transcript?.source ?? "youtube_creator",
      },
      {
        role: "thumbnail",
        fileName: "thumbnail.jpg",
        provenance: "yt_dlp",
      },
    ],
    ...overrides,
  };
};

const finalDirectoryFor = (projectRoot, clipPackage) =>
  join(
    projectRoot,
    "public",
    "generated",
    clipPackage.videoId,
    clipPackage.packageVersion,
    `clip-${clipPackage.rank}`,
  );

const stagingDirectoryFor = (projectRoot, clipPackage, stagingId) =>
  join(
    dirname(finalDirectoryFor(projectRoot, clipPackage)),
    `.clip-${clipPackage.rank}.staging-${stagingId}`,
  );

const writePublishedPackage = async (
  projectRoot,
  clipPackage,
  {
    manifest = packageManifest(clipPackage),
    missingFile,
    emptyFile,
    captionsContents = '[{"text":"hello"}]\n',
  } = {},
) => {
  const directory = finalDirectoryFor(projectRoot, clipPackage);
  await mkdir(directory, { recursive: true });
  for (const [fileName, contents] of [
    ["audio.wav", "audio"],
    ["captions.json", captionsContents],
    ["thumbnail.jpg", "image"],
  ]) {
    if (fileName !== missingFile) {
      await writeFile(
        join(directory, fileName),
        fileName === emptyFile ? "" : contents,
      );
    }
  }
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(manifest)}\n`,
  );
  return directory;
};

const createRunner = ({ onThumbnail, emptyThumbnail = false } = {}) => {
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push({ command, args });
    if (command === "ffprobe") return { stdout: "20\n" };
    const outputTemplate = args[args.indexOf("--output") + 1];
    await mkdir(dirname(outputTemplate), { recursive: true });
    if (args.includes("--extract-audio")) {
      await writeFile(outputTemplate.replace("%(ext)s", "wav"), "audio");
    } else if (args.includes("--write-subs")) {
      await writeFile(
        outputTemplate.replace("%(ext)s", "en.srt"),
        "1\n00:00:10,000 --> 00:00:15,000\nHello world\n",
      );
      await writeFile(
        outputTemplate.replace("%(ext)s", "en-US.srt"),
        "1\n00:00:10,000 --> 00:00:15,000\nHello world\n",
      );
    } else if (args.includes("--write-thumbnail")) {
      await onThumbnail?.({ beforeWrite: true });
      await writeFile(
        outputTemplate.replace("%(ext)s", "jpg"),
        emptyThumbnail ? "" : "image",
      );
      await onThumbnail?.({ beforeWrite: false });
    }
    return { stdout: "" };
  };
  return { calls, runCommand };
};

const assertMissing = async (path) => {
  await assert.rejects(stat(path), { code: "ENOENT" });
};

test("partial audio arguments request only the selected time range", () => {
  const args = buildPartialAudioArgs({
    sourceUrl: "https://youtu.be/video-1",
    startSeconds: 12.5,
    endSeconds: 42.25,
    outputTemplate: "/tmp/audio.%(ext)s",
  });

  assert.ok(args.includes("--no-playlist"));
  assert.deepEqual(
    args.slice(
      args.indexOf("--download-sections"),
      args.indexOf("--download-sections") + 2,
    ),
    ["--download-sections", "*12.5-42.25"],
  );
  assert.ok(args.includes("--extract-audio"));
  assert.ok(args.includes("--force-keyframes-at-cuts"));
  assert.deepEqual(
    args.slice(
      args.indexOf("--audio-format"),
      args.indexOf("--audio-format") + 2,
    ),
    ["--audio-format", "wav"],
  );
});

test("captions are clipped to the selection and rebased to local time", () => {
  const captions = trimAndRebaseCaptions(
    [
      {
        text: "before",
        startMs: 8_000,
        endMs: 12_000,
        timestampMs: 10_000,
        confidence: 1,
      },
      {
        text: "inside",
        startMs: 15_000,
        endMs: 20_000,
        timestampMs: 17_500,
        confidence: 1,
      },
      {
        text: "after",
        startMs: 30_000,
        endMs: 35_000,
        timestampMs: 32_500,
        confidence: 1,
      },
    ],
    { startSeconds: 10, endSeconds: 30 },
  );

  assert.deepEqual(captions, [
    { text: "before", startMs: 0, endMs: 2_000, timestampMs: 0, confidence: 1 },
    {
      text: "inside",
      startMs: 5_000,
      endMs: 10_000,
      timestampMs: 7_500,
      confidence: 1,
    },
  ]);
});

test("cue-level captions become individually timed words without embedded newlines", () => {
  assert.deepEqual(
    splitCaptionsIntoTimedWords([
      {
        text: "Hello\nworld again.",
        startMs: 1_000,
        endMs: 4_000,
        timestampMs: 2_500,
        confidence: 0.8,
        pageBreakAfter: true,
      },
    ]),
    [
      {
        text: "Hello",
        startMs: 1_000,
        endMs: 2_000,
        timestampMs: 1_500,
        confidence: 0.8,
      },
      {
        text: " world",
        startMs: 2_000,
        endMs: 3_000,
        timestampMs: 2_500,
        confidence: 0.8,
      },
      {
        text: " again.",
        startMs: 3_000,
        endMs: 4_000,
        timestampMs: 3_500,
        confidence: 0.8,
        pageBreakAfter: true,
      },
    ],
  );
});

test("parsed punctuated SRT sentences keep readable spacing and sentence-final punctuation", () => {
  const { captions } = parseSrt({
    input: [
      "1",
      "00:00:00,000 --> 00:00:01,000",
      "First sentence.",
      "",
      "2",
      "00:00:01,000 --> 00:00:02,000",
      "Second sentence!",
    ].join("\n"),
  });

  const words = splitCaptionsIntoTimedWords(captions);

  assert.equal(
    words.map(({ text }) => text).join(""),
    "First sentence. Second sentence!",
  );
  assert.deepEqual(
    words.filter(({ text }) => /[.!?]$/.test(text)).map(({ text }) => text),
    [" sentence.", " sentence!"],
  );
});

test("rejects navigation package path components before creating package output", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "clip-package-paths-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const validPackage = exampleClipPackage({ rank: 1 });

  for (const [field, label] of [
    ["videoId", "video ID"],
    ["packageVersion", "package version"],
  ]) {
    for (const value of [undefined, null, "", ".", ".."]) {
      let processCalls = 0;
      await assert.rejects(
        acquireClipPackageAssets(
          { ...validPackage, [field]: value },
          {
            projectRoot,
            runCommand: async () => {
              processCalls += 1;
              throw new Error("external command should not run");
            },
          },
        ),
        { message: `Invalid ${label}: ${value}` },
      );
      assert.equal(processCalls, 0);
    }
  }

  await assert.rejects(stat(join(projectRoot, "public")), { code: "ENOENT" });
});

test("rejects rank and interval errors before filesystem writes or commands", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "clip-package-paths-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));

  for (const clipPackage of [
    exampleClipPackage({ rank: 0 }),
    exampleClipPackage({ startSeconds: -1 }),
    exampleClipPackage({ endSeconds: 10 }),
    exampleClipPackage({ score: Number.NaN }),
    exampleClipPackage({ score: Number.POSITIVE_INFINITY }),
    exampleClipPackage({ score: Number.NEGATIVE_INFINITY }),
    exampleClipPackage({ score: undefined }),
    exampleClipPackage({ score: "0.9" }),
  ]) {
    let processCalls = 0;
    await assert.rejects(
      acquireClipPackageAssets(clipPackage, {
        projectRoot,
        createStagingId: () => "unused",
        runCommand: async () => {
          processCalls += 1;
          throw new Error("external command should not run");
        },
      }),
      /Invalid package (rank|time range|score)/,
    );
    assert.equal(processCalls, 0);
  }

  await assertMissing(join(projectRoot, "public"));
});

test("rejects a managed ancestor symlink without touching its external target", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "clip-package-ancestor-"));
  const externalRoot = await mkdtemp(join(tmpdir(), "clip-package-external-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  t.after(() => rm(externalRoot, { recursive: true, force: true }));
  await mkdir(join(projectRoot, "public"));
  await symlink(externalRoot, join(projectRoot, "public", "generated"), "dir");
  let processCalls = 0;

  const error = await acquireClipPackageAssets(exampleClipPackage(), {
    projectRoot,
    createStagingId: () => "must-not-be-used",
    runCommand: async () => {
      processCalls += 1;
      throw new Error("external command should not run");
    },
  }).then(
    () => null,
    (acquisitionError) => acquisitionError,
  );

  assert.deepEqual(
    {
      isBoundedDiagnostic:
        /Invalid managed clip package path.*symbolic link/.test(error?.message),
      processCalls,
      externalEntries: await readdir(externalRoot),
    },
    {
      isBoundedDiagnostic: true,
      processCalls: 0,
      externalEntries: [],
    },
  );
});

test("rejects a non-directory managed ancestor before external commands", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "clip-package-ancestor-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(join(projectRoot, "public"));
  await writeFile(join(projectRoot, "public", "generated"), "not a directory");
  let processCalls = 0;

  await assert.rejects(
    acquireClipPackageAssets(exampleClipPackage(), {
      projectRoot,
      createStagingId: () => "must-not-be-used",
      runCommand: async () => {
        processCalls += 1;
        throw new Error("external command should not run");
      },
    }),
    /Invalid managed clip package path.*not a directory/,
  );
  assert.equal(processCalls, 0);
});

test("rejects an unsafe staging ID before filesystem writes or commands", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "clip-package-paths-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));

  for (const stagingId of [undefined, null, "", "../escape"]) {
    let processCalls = 0;
    await assert.rejects(
      acquireClipPackageAssets(exampleClipPackage(), {
        projectRoot,
        createStagingId: () => stagingId,
        runCommand: async () => {
          processCalls += 1;
          throw new Error("external command should not run");
        },
      }),
      /Invalid staging ID/,
    );
    assert.equal(processCalls, 0);
  }
  await assertMissing(join(projectRoot, "public"));
});

test("stages and atomically publishes a complete deterministic package", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "clip-package-assets-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const clipPackage = exampleClipPackage();
  const { calls, runCommand } = createRunner();
  const finalDirectory = finalDirectoryFor(projectRoot, clipPackage);
  const stagingDirectory = stagingDirectoryFor(
    projectRoot,
    clipPackage,
    "test-id",
  );

  const assets = await acquireClipPackageAssets(clipPackage, {
    projectRoot,
    runCommand,
    createStagingId: () => "test-id",
  });

  assert.deepEqual(assets, [
    {
      role: "audio",
      relativePath: "public/generated/video-1/v1/clip-2/audio.wav",
      provenance: "yt_dlp",
    },
    {
      role: "captions",
      relativePath: "public/generated/video-1/v1/clip-2/captions.json",
      provenance: "youtube_creator",
    },
    {
      role: "thumbnail",
      relativePath: "public/generated/video-1/v1/clip-2/thumbnail.jpg",
      provenance: "yt_dlp",
    },
  ]);
  assert.ok(
    calls.every(({ args }) =>
      args
        .filter(
          (argument) =>
            typeof argument === "string" && argument.startsWith(projectRoot),
        )
        .every((path) => path.startsWith(stagingDirectory)),
    ),
  );
  assert.deepEqual((await readdir(finalDirectory)).sort(), [
    "audio.wav",
    "captions.json",
    "package.json",
    "thumbnail.jpg",
  ]);
  for (const fileName of [
    "audio.wav",
    "captions.json",
    "thumbnail.jpg",
    "package.json",
  ]) {
    assert.ok((await stat(join(finalDirectory, fileName))).size > 0);
  }
  await assertMissing(stagingDirectory);
  assert.ok(
    assets.every(({ relativePath }) => !relativePath.includes("test-id")),
  );
  assert.equal(
    calls.filter(({ args }) => args.includes("--write-auto-subs")).length,
    0,
  );
  const captionCall = calls.find(({ args }) => args.includes("--write-subs"));
  assert.deepEqual(
    captionCall.args.slice(
      captionCall.args.indexOf("--convert-subs"),
      captionCall.args.indexOf("--convert-subs") + 2,
    ),
    ["--convert-subs", "srt"],
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(finalDirectory, "captions.json"), "utf8")),
    [
      {
        text: "Hello",
        startMs: 0,
        endMs: 2_500,
        timestampMs: 1_250,
        confidence: 1,
      },
      {
        text: " world",
        startMs: 2_500,
        endMs: 5_000,
        timestampMs: 3_750,
        confidence: 1,
      },
    ],
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(finalDirectory, "package.json"), "utf8")),
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
        { role: "audio", fileName: "audio.wav", provenance: "yt_dlp" },
        {
          role: "captions",
          fileName: "captions.json",
          provenance: "youtube_creator",
        },
        { role: "thumbnail", fileName: "thumbnail.jpg", provenance: "yt_dlp" },
      ],
    },
  );
});

test("derives package captions from a persisted transcript without downloading captions", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "clip-package-transcript-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const transcript = exampleTranscript();
  const clipPackage = exampleClipPackage({ transcript });
  const { calls, runCommand } = createRunner();

  const assets = await acquireClipPackageAssets(clipPackage, {
    projectRoot,
    runCommand,
    createStagingId: () => "transcript",
  });

  const ytDlpCalls = calls.filter(({ command }) => command === "yt-dlp");
  assert.equal(
    ytDlpCalls.filter(({ args }) =>
      args.some((argument) =>
        ["--write-subs", "--write-auto-subs"].includes(argument),
      ),
    ).length,
    0,
  );
  assert.ok(
    ytDlpCalls.every(
      ({ args }) =>
        args.includes("--skip-download") ||
        args.includes("--download-sections"),
    ),
  );
  assert.equal(
    ytDlpCalls.filter(({ args }) => args.includes("--download-sections"))
      .length,
    1,
  );
  const directory = finalDirectoryFor(projectRoot, clipPackage);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "captions.json"), "utf8")),
    [
      {
        text: "Hello",
        startMs: 0,
        endMs: 5_000,
        timestampMs: 2_500,
        confidence: null,
      },
      {
        text: " world",
        startMs: 5_000,
        endMs: 10_000,
        timestampMs: 7_500,
        confidence: null,
      },
      {
        text: " Persisted",
        startMs: 10_000,
        endMs: 15_000,
        timestampMs: 12_500,
        confidence: null,
      },
      {
        text: " transcript",
        startMs: 15_000,
        endMs: 20_000,
        timestampMs: 17_500,
        confidence: null,
      },
    ],
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
      .transcript,
    {
      id: 17,
      sha256: transcript.sha256,
      source: "youtube_creator",
      language: "en",
    },
  );
  assert.equal(
    assets.find(({ role }) => role === "captions").provenance,
    "youtube_creator",
  );
});

test("exposes canonical final and sibling staging paths", () => {
  assert.equal(typeof clipPackageAssets.getClipPackagePaths, "function");

  assert.deepEqual(
    clipPackageAssets.getClipPackagePaths(exampleClipPackage(), {
      projectRoot: "/project",
      stagingId: "test-id",
    }),
    {
      parentDirectory: "/project/public/generated/video-1/v1",
      finalDirectory: "/project/public/generated/video-1/v1/clip-2",
      stagingDirectory:
        "/project/public/generated/video-1/v1/.clip-2.staging-test-id",
    },
  );
});

test("cleans staging and publishes nothing when acquisition fails midway", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "clip-package-assets-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const clipPackage = exampleClipPackage();
  const finalDirectory = finalDirectoryFor(projectRoot, clipPackage);
  const stagingDirectory = stagingDirectoryFor(
    projectRoot,
    clipPackage,
    "mid-failure",
  );
  const { runCommand } = createRunner({
    onThumbnail: ({ beforeWrite }) => {
      if (beforeWrite) throw new Error("thumbnail download failed");
    },
  });

  await assert.rejects(
    acquireClipPackageAssets(clipPackage, {
      projectRoot,
      runCommand,
      createStagingId: () => "mid-failure",
    }),
    /thumbnail download failed/,
  );
  await assertMissing(finalDirectory);
  await assertMissing(stagingDirectory);
});

test("cleans staging and publishes nothing when a required asset is empty", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "clip-package-assets-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const clipPackage = exampleClipPackage();
  const finalDirectory = finalDirectoryFor(projectRoot, clipPackage);
  const stagingDirectory = stagingDirectoryFor(
    projectRoot,
    clipPackage,
    "empty-thumbnail",
  );
  const { runCommand } = createRunner({ emptyThumbnail: true });

  await assert.rejects(
    acquireClipPackageAssets(clipPackage, {
      projectRoot,
      runCommand,
      createStagingId: () => "empty-thumbnail",
    }),
    /thumbnail asset is empty/,
  );
  await assertMissing(finalDirectory);
  await assertMissing(stagingDirectory);
});

test("reuses a complete published package without external commands", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "clip-package-assets-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const clipPackage = exampleClipPackage();
  await writePublishedPackage(projectRoot, clipPackage);
  let processCalls = 0;

  const assets = await acquireClipPackageAssets(clipPackage, {
    projectRoot,
    createStagingId: () => "unused",
    runCommand: async () => {
      processCalls += 1;
      throw new Error("external command should not run");
    },
  });

  assert.equal(processCalls, 0);
  assert.deepEqual(assets, [
    {
      role: "audio",
      relativePath: "public/generated/video-1/v1/clip-2/audio.wav",
      provenance: "yt_dlp",
    },
    {
      role: "captions",
      relativePath: "public/generated/video-1/v1/clip-2/captions.json",
      provenance: "youtube_creator",
    },
    {
      role: "thumbnail",
      relativePath: "public/generated/video-1/v1/clip-2/thumbnail.jpg",
      provenance: "yt_dlp",
    },
  ]);
});

test("does not reuse a published transcript package with different transcript provenance", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "clip-package-transcript-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const transcript = exampleTranscript();
  const clipPackage = exampleClipPackage({ transcript });
  const directory = await writePublishedPackage(projectRoot, clipPackage, {
    manifest: packageManifest(clipPackage, {
      transcript: {
        id: transcript.id,
        sha256: "0".repeat(64),
        source: transcript.source,
        language: transcript.language,
      },
    }),
  });
  const manifestBefore = await readFile(
    join(directory, "package.json"),
    "utf8",
  );
  let processCalls = 0;

  await assert.rejects(
    acquireClipPackageAssets(clipPackage, {
      projectRoot,
      runCommand: async () => {
        processCalls += 1;
        throw new Error("external command should not run");
      },
    }),
    /Invalid published clip package.*transcript identity mismatch/,
  );

  assert.equal(processCalls, 0);
  assert.equal(
    await readFile(join(directory, "package.json"), "utf8"),
    manifestBefore,
  );
});

test("inspectPublishedClipPackage distinguishes absence from a valid package", async (t) => {
  assert.equal(
    typeof clipPackageAssets.inspectPublishedClipPackage,
    "function",
  );
  const projectRoot = await mkdtemp(join(tmpdir(), "clip-package-assets-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const clipPackage = exampleClipPackage();

  assert.equal(
    await clipPackageAssets.inspectPublishedClipPackage(clipPackage, {
      projectRoot,
    }),
    null,
  );
  await writePublishedPackage(projectRoot, clipPackage);
  const inspected = await clipPackageAssets.inspectPublishedClipPackage(
    clipPackage,
    { projectRoot },
  );
  assert.equal(inspected.assets.length, 3);
  assert.ok(
    inspected.assets.every(({ relativePath }) =>
      relativePath.startsWith("public/generated/video-1/v1/clip-2/"),
    ),
  );
});

test("rejects invalid published packages without commands or mutation", async (t) => {
  const invalidPackages = [
    {
      name: "wrong identity",
      options: (clipPackage) => ({
        manifest: packageManifest(clipPackage, { packageVersion: "v2" }),
      }),
    },
    {
      name: "wrong interval",
      options: (clipPackage) => ({
        manifest: packageManifest(clipPackage, {
          interval: {
            ...packageManifest(clipPackage).interval,
            startSeconds: 11,
          },
        }),
      }),
    },
    {
      name: "wrong asset descriptor",
      options: (clipPackage) => ({
        manifest: packageManifest(clipPackage, {
          assets: [
            {
              role: "audio",
              fileName: "../audio.wav",
              provenance: "unknown",
            },
            ...packageManifest(clipPackage).assets.slice(1),
          ],
        }),
      }),
    },
    {
      name: "missing required file",
      options: () => ({ missingFile: "audio.wav" }),
    },
    {
      name: "empty required file",
      options: () => ({ emptyFile: "thumbnail.jpg" }),
    },
    {
      name: "empty caption list",
      options: () => ({ captionsContents: "[]\n" }),
    },
  ];

  for (const fixture of invalidPackages) {
    await t.test(fixture.name, async (t) => {
      const projectRoot = await mkdtemp(
        join(tmpdir(), "clip-package-invalid-"),
      );
      t.after(() => rm(projectRoot, { recursive: true, force: true }));
      const clipPackage = exampleClipPackage();
      const finalDirectory = await writePublishedPackage(
        projectRoot,
        clipPackage,
        fixture.options(clipPackage),
      );
      const manifestBefore = await readFile(
        join(finalDirectory, "package.json"),
        "utf8",
      );
      let processCalls = 0;

      await assert.rejects(
        acquireClipPackageAssets(clipPackage, {
          projectRoot,
          createStagingId: () => "unused",
          runCommand: async () => {
            processCalls += 1;
            throw new Error("external command should not run");
          },
        }),
        /Invalid published clip package/,
      );

      assert.equal(processCalls, 0);
      assert.equal(
        await readFile(join(finalDirectory, "package.json"), "utf8"),
        manifestBefore,
      );
      assert.ok((await stat(finalDirectory)).isDirectory());
    });
  }
});

test("rejects a malformed published manifest without exposing its contents", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "clip-package-invalid-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const clipPackage = exampleClipPackage();
  const finalDirectory = await writePublishedPackage(projectRoot, clipPackage);
  const secret = "credential-like-secret";
  await writeFile(join(finalDirectory, "package.json"), `{${secret}`);

  await assert.rejects(
    acquireClipPackageAssets(clipPackage, {
      projectRoot,
      runCommand: async () => {
        throw new Error("external command should not run");
      },
    }),
    (error) => {
      assert.match(error.message, /Invalid published clip package/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.ok(error.message.length < 300);
      return true;
    },
  );
  assert.equal(
    await readFile(join(finalDirectory, "package.json"), "utf8"),
    `{${secret}`,
  );
});

test("rejects symlinks at published package trust boundaries", async (t) => {
  const clipPackage = exampleClipPackage();

  await t.test("final directory", async (t) => {
    const projectRoot = await mkdtemp(join(tmpdir(), "clip-package-symlink-"));
    const externalRoot = await mkdtemp(
      join(tmpdir(), "clip-package-external-"),
    );
    t.after(() => rm(projectRoot, { recursive: true, force: true }));
    t.after(() => rm(externalRoot, { recursive: true, force: true }));
    const externalDirectory = await writePublishedPackage(
      externalRoot,
      clipPackage,
    );
    const finalDirectory = finalDirectoryFor(projectRoot, clipPackage);
    await mkdir(dirname(finalDirectory), { recursive: true });
    await symlink(externalDirectory, finalDirectory, "dir");

    await assert.rejects(
      acquireClipPackageAssets(clipPackage, {
        projectRoot,
        runCommand: async () => {
          throw new Error("external command should not run");
        },
      }),
      /Invalid published clip package.*symbolic link/,
    );
    assert.ok((await stat(externalDirectory)).isDirectory());
  });

  for (const fileName of ["package.json", "audio.wav", "captions.json"]) {
    await t.test(`${fileName} asset`, async (t) => {
      const projectRoot = await mkdtemp(
        join(tmpdir(), "clip-package-symlink-"),
      );
      const externalRoot = await mkdtemp(
        join(tmpdir(), "clip-package-external-"),
      );
      t.after(() => rm(projectRoot, { recursive: true, force: true }));
      t.after(() => rm(externalRoot, { recursive: true, force: true }));
      const finalDirectory = await writePublishedPackage(
        projectRoot,
        clipPackage,
      );
      const packagePath = join(finalDirectory, fileName);
      const externalPath = join(externalRoot, fileName);
      const contents = await readFile(packagePath);
      await writeFile(externalPath, contents);
      await rm(packagePath);
      await symlink(externalPath, packagePath);

      await assert.rejects(
        acquireClipPackageAssets(clipPackage, {
          projectRoot,
          runCommand: async () => {
            throw new Error("external command should not run");
          },
        }),
        /Invalid published clip package.*symbolic link/,
      );
      assert.deepEqual(await readFile(externalPath), contents);
    });
  }
});

test("reuses a matching winner when promotion collides", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "clip-package-assets-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const clipPackage = exampleClipPackage();
  const stagingDirectory = stagingDirectoryFor(
    projectRoot,
    clipPackage,
    "loser",
  );
  let publishedWinner = false;
  const { runCommand } = createRunner({
    onThumbnail: async ({ beforeWrite }) => {
      if (beforeWrite || publishedWinner) return;
      assert.ok((await stat(stagingDirectory)).isDirectory());
      await writePublishedPackage(projectRoot, clipPackage);
      publishedWinner = true;
    },
  });

  const assets = await acquireClipPackageAssets(clipPackage, {
    projectRoot,
    runCommand,
    createStagingId: () => "loser",
  });

  assert.equal(publishedWinner, true);
  assert.ok(
    assets.every(({ relativePath }) => !relativePath.includes("loser")),
  );
  await assertMissing(stagingDirectory);
});

test("does not overwrite a conflicting winner when promotion collides", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "clip-package-assets-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const clipPackage = exampleClipPackage();
  const stagingDirectory = stagingDirectoryFor(
    projectRoot,
    clipPackage,
    "conflict-loser",
  );
  let conflictingManifest;
  const { runCommand } = createRunner({
    onThumbnail: async ({ beforeWrite }) => {
      if (beforeWrite || conflictingManifest) return;
      conflictingManifest = packageManifest(clipPackage, {
        packageVersion: "other-version",
      });
      await writePublishedPackage(projectRoot, clipPackage, {
        manifest: conflictingManifest,
      });
    },
  });

  await assert.rejects(
    acquireClipPackageAssets(clipPackage, {
      projectRoot,
      runCommand,
      createStagingId: () => "conflict-loser",
    }),
    /Invalid published clip package/,
  );

  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(finalDirectoryFor(projectRoot, clipPackage), "package.json"),
        "utf8",
      ),
    ),
    conflictingManifest,
  );
  await assertMissing(stagingDirectory);
});

test("falls back to automatic captions when creator captions are unavailable", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "clip-package-assets-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push({ command, args });
    if (command === "ffprobe") return { stdout: "20\n" };
    const outputTemplate = args[args.indexOf("--output") + 1];
    await mkdir(dirname(outputTemplate), { recursive: true });
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
    return { stdout: "" };
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
    { projectRoot, runCommand, createStagingId: () => "automatic" },
  );

  assert.equal(
    calls.filter(({ args }) => args.includes("--write-subs")).length,
    1,
  );
  assert.equal(
    calls.filter(({ args }) => args.includes("--write-auto-subs")).length,
    1,
  );
  assert.equal(
    assets.find(({ role }) => role === "captions").provenance,
    "youtube_auto",
  );
});
