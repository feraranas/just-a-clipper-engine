import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  fetchYoutubeTranscript,
  normalizeTranscriptCues,
  selectEnglishCaptionTrack,
} from "./youtube-transcript-core.mjs";

test("selects creator then automatic English tracks in deterministic priority order", () => {
  const metadata = {
    subtitles: {
      fr: [{}],
      "en-ZZ": [{}],
      en_GB: [{}],
      "en-US": [{}],
      "en-orig": [{}],
    },
    automatic_captions: { en: [{}] },
  };
  assert.deepEqual(selectEnglishCaptionTrack(metadata), {
    source: "youtube_creator",
    language: "en-orig",
  });
  delete metadata.subtitles["en-orig"];
  assert.equal(selectEnglishCaptionTrack(metadata).language, "en-US");
  delete metadata.subtitles["en-US"];
  assert.equal(selectEnglishCaptionTrack(metadata).language, "en_GB");
  delete metadata.subtitles.en_GB;
  assert.equal(selectEnglishCaptionTrack(metadata).language, "en-ZZ");
  metadata.subtitles = { es: [{}], fr: [{}] };
  assert.deepEqual(selectEnglishCaptionTrack(metadata), {
    source: "youtube_auto",
    language: "en",
  });
});

test("uses normalized lexical order for remaining English keys and never non-English keys", () => {
  assert.equal(
    selectEnglishCaptionTrack({ subtitles: { en_z: [], "en-A": [], de: [] } })
      .language,
    "en-A",
  );
  assert.equal(
    selectEnglishCaptionTrack({
      subtitles: { es: [] },
      automatic_captions: { "en-CA": [], ja: [] },
    }).language,
    "en-CA",
  );
  assert.throws(
    () =>
      selectEnglishCaptionTrack({
        subtitles: { es: [] },
        automatic_captions: { fr: [] },
      }),
    /English captions are unavailable/,
  );
});

test("normalizes, validates, stable-sorts, retains ties, then assigns IDs", () => {
  assert.deepEqual(
    normalizeTranscriptCues([
      { startMs: 20, endMs: 30, text: " third\n cue " },
      { startMs: 0, endMs: 10, text: " first   cue " },
      { startMs: 0, endMs: 10, text: " tied cue" },
    ]),
    [
      { id: "c000001", startMs: 0, endMs: 10, text: "first cue" },
      { id: "c000002", startMs: 0, endMs: 10, text: "tied cue" },
      { id: "c000003", startMs: 20, endMs: 30, text: "third cue" },
    ],
  );
  for (const cues of [
    [],
    [{ startMs: -1, endMs: 1, text: "x" }],
    [{ startMs: 0, endMs: 0, text: "x" }],
    [{ startMs: NaN, endMs: 1, text: "x" }],
  ]) {
    assert.throws(
      () => normalizeTranscriptCues(cues),
      /valid transcript cue|no valid cues/,
    );
  }
});

test("fetches exact selected caption only, hashes canonical cues, and removes temp files", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "transcript-test-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push({ command, args });
    if (args.includes("--dump-single-json"))
      return {
        stdout: JSON.stringify({
          subtitles: { en: [{}], "en-US": [{}] },
          automatic_captions: { en: [{}] },
        }),
      };
    const output = args[args.indexOf("--output") + 1].replace(
      "%(ext)s",
      "en.srt",
    );
    await mkdir(dirname(output), { recursive: true });
    await writeFile(
      output,
      "2\n00:00:02,000 --> 00:00:03,000\nCafé two\n\n1\n00:00:00,000 --> 00:00:01,000\nOne\n",
    );
    return { stdout: "" };
  };
  const first = await fetchYoutubeTranscript("https://youtu.be/id", {
    runCommand,
    tempRoot,
  });
  const second = await fetchYoutubeTranscript("https://youtu.be/id", {
    runCommand,
    tempRoot,
  });
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.cues.map(({ text }) => text),
    ["One", "Café two"],
  );
  assert.equal(first.source, "youtube_creator");
  assert.equal(first.language, "en");
  assert.equal(
    first.sha256,
    "5c1198d58a7e4da1c9af1150cd6bfcca85ca3a36032f52e6b618786a85ec20c1",
  );
  assert.equal(first.canonicalUtf8Bytes, 120);
  assert.deepEqual(await readdir(tempRoot), []);
  for (const { args } of calls) {
    assert.ok(args.includes("--skip-download"));
    assert.ok(args.includes("--no-playlist"));
    assert.equal(args.at(-2), "--");
    assert.equal(args.at(-1), "https://youtu.be/id");
    assert.ok(!args.includes("--download-sections"));
    assert.ok(!args.includes("--format"));
    assert.ok(!args.includes("--extract-audio"));
  }
  const captionCall = calls.find(({ args }) => args.includes("--write-subs"));
  assert.deepEqual(
    captionCall.args.slice(
      captionCall.args.indexOf("--sub-langs"),
      captionCall.args.indexOf("--sub-langs") + 2,
    ),
    ["--sub-langs", "en"],
  );
  assert.deepEqual(
    captionCall.args.slice(
      captionCall.args.indexOf("--convert-subs"),
      captionCall.args.indexOf("--convert-subs") + 2,
    ),
    ["--convert-subs", "srt"],
  );
  assert.ok(!captionCall.args.includes("--write-auto-subs"));
});

test("uses automatic flag for an exact automatic language and cleans up after failures", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "transcript-test-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const calls = [];
  const runCommand = async (_command, args) => {
    calls.push(args);
    if (args.includes("--dump-single-json"))
      return {
        stdout: JSON.stringify({ automatic_captions: { "en-GB": [{}] } }),
      };
    throw new Error("download failed");
  };
  await assert.rejects(
    fetchYoutubeTranscript("https://youtu.be/id", { runCommand, tempRoot }),
    /download failed/,
  );
  assert.ok(calls[1].includes("--write-auto-subs"));
  assert.deepEqual(
    calls[1].slice(
      calls[1].indexOf("--sub-langs"),
      calls[1].indexOf("--sub-langs") + 2,
    ),
    ["--sub-langs", "en-GB"],
  );
  assert.deepEqual(await readdir(tempRoot), []);
});

test("rejects transcripts over the canonical UTF-8 byte limit without echoing text", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "transcript-test-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const secret = "SECRET".repeat(100_000);
  const runCommand = async (_command, args) => {
    if (args.includes("--dump-single-json"))
      return { stdout: JSON.stringify({ subtitles: { en: [{}] } }) };
    const output = args[args.indexOf("--output") + 1].replace(
      "%(ext)s",
      "en.srt",
    );
    await writeFile(output, `1\n00:00:00,000 --> 00:00:01,000\n${secret}\n`);
    return { stdout: "" };
  };
  const error = await fetchYoutubeTranscript("https://youtu.be/id", {
    runCommand,
    tempRoot,
  }).then(
    () => null,
    (value) => value,
  );
  assert.match(error.message, /524288/);
  assert.ok(!error.message.includes("SECRET"));
  assert.deepEqual(await readdir(tempRoot), []);
});
