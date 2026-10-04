import assert from "node:assert/strict";
import test from "node:test";

import { runAudiogramUrlCli } from "./audiogram-url.mjs";

const successResult = {
  contractVersion: 1,
  status: "complete",
  source: {
    videoId: "dQw4w9WgXcQ",
    title: "A source video",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  },
  artifactPaths: ["out/treatments/audiogram-basic/1/dQw4w9WgXcQ/v1/clip-1.mp4"],
};

const makeIO = () => {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (value) => stdout.push(value) },
      stderr: { write: (value) => stderr.push(value) },
    },
  };
};

test("rejects a missing URL as a usage error without writing JSON", async () => {
  const { io, stdout, stderr } = makeIO();
  const exitCode = await runAudiogramUrlCli([], io);

  assert.equal(exitCode, 2);
  assert.deepEqual(stdout, []);
  assert.match(stderr.join(""), /--url/);
});

test("rejects unknown flags as usage errors", async () => {
  const { io, stdout, stderr } = makeIO();
  const exitCode = await runAudiogramUrlCli(["--other"], io);

  assert.equal(exitCode, 2);
  assert.deepEqual(stdout, []);
  assert.match(stderr.join(""), /other|unknown|option/i);
});

test("writes exactly one JSON contract for successful processing", async () => {
  const { io, stdout, stderr } = makeIO();
  const exitCode = await runAudiogramUrlCli(
    ["--url", successResult.source.url],
    io,
    { runPipeline: async () => successResult },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(stdout, [`${JSON.stringify(successResult)}\n`]);
  assert.deepEqual(stderr, []);
});

test("returns structured terminal failures as JSON while reserving nonzero exit for usage errors", async () => {
  const { io, stdout, stderr } = makeIO();
  const failure = {
    contractVersion: 1,
    status: "failed",
    source: null,
    artifactPaths: [],
    error: { code: "INVALID_HOST", message: "URL host is not supported." },
  };
  const exitCode = await runAudiogramUrlCli(
    ["--url", "https://example.com/video"],
    io,
    { runPipeline: async () => failure },
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(stdout, [`${JSON.stringify(failure)}\n`]);
  assert.deepEqual(stderr, []);
});

test("converts an unexpected runner exception into one safe structured failure", async () => {
  const { io, stdout, stderr } = makeIO();
  const exitCode = await runAudiogramUrlCli(
    ["--url", successResult.source.url],
    io,
    { runPipeline: async () => { throw new Error("runner exploded"); } },
  );
  const result = JSON.parse(stdout.join(""));

  assert.equal(exitCode, 0);
  assert.equal(stdout.length, 1);
  assert.equal(result.contractVersion, 1);
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "RUNNER_FAILED");
  assert.equal(stderr.length, 0);
});
