import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import * as pipelineLoggerApi from "./pipeline-logger.mjs";
const { createPipelineLogger, readPipelineEvents } = pipelineLoggerApi;

test("writes structured pipeline events as JSONL without sensitive payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pipeline-logs-"));
  const logPath = join(directory, "pipeline.jsonl");
  const logger = createPipelineLogger({
    logPath,
    now: () => "2026-09-30T12:00:00.000Z",
  });

  await logger.event({
    runId: "run-1",
    stage: "jev",
    status: "completed",
    videoId: "video-1",
    apiKey: "must-not-be-written",
    transcript: "must-not-be-written",
  });

  const lines = (await readFile(logPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    timestamp: "2026-09-30T12:00:00.000Z",
    runId: "run-1",
    stage: "jev",
    status: "completed",
    videoId: "video-1",
  });
});

test("reads only the newest bounded events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pipeline-logs-"));
  const logPath = join(directory, "pipeline.jsonl");
  const logger = createPipelineLogger({ logPath, now: () => "now" });
  await logger.event({ runId: "run-1", stage: "one", status: "started" });
  await logger.event({ runId: "run-1", stage: "two", status: "completed" });
  assert.deepEqual(await readPipelineEvents(logPath, { limit: 1 }), [
    { timestamp: "now", runId: "run-1", stage: "two", status: "completed" },
  ]);
});

test("persists sanitized failure diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pipeline-logs-"));
  const logPath = join(directory, "pipeline.jsonl");
  const logger = createPipelineLogger({ logPath, now: () => "now" });

  await logger.event({
    runId: "run-1",
    stage: "transcript-sync",
    status: "failed",
    videoId: "video-1",
    errorCode: "oauth_responses_timeout",
    errorMessage: "provider timed out",
    transcript: "must-not-be-written",
    apiKey: "must-not-be-written",
  });

  assert.deepEqual(await readPipelineEvents(logPath), [{
    timestamp: "now",
    runId: "run-1",
    stage: "transcript-sync",
    status: "failed",
    videoId: "video-1",
    errorCode: "oauth_responses_timeout",
    errorMessage: "provider timed out",
  }]);
});

test("logger write failures are best effort", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pipeline-logs-"));
  const blocker = join(directory, "not-a-directory");
  await writeFile(blocker, "file blocks directory creation");
  const logger = createPipelineLogger({ logPath: join(blocker, "pipeline.jsonl") });

  await assert.doesNotReject(logger.event({ stage: "render", status: "started" }));
});

test("skips a malformed partial trailing record and returns valid events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pipeline-logs-"));
  const logPath = join(directory, "pipeline.jsonl");
  await writeFile(logPath, [
    '{"timestamp":"one","stage":"sync","status":"completed"}',
    '{"timestamp":"two","stage":"render","status":"completed"}',
    '{"timestamp":"partial","stage":"render"',
    "",
  ].join("\n"));

  assert.deepEqual(await readPipelineEvents(logPath, { limit: 1 }), [
    { timestamp: "two", stage: "render", status: "completed" },
  ]);
});

test("does not parse malformed history older than the requested tail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pipeline-logs-"));
  const logPath = join(directory, "pipeline.jsonl");
  await writeFile(logPath, [
    "x".repeat(128 * 1024),
    '{"timestamp":"latest","stage":"render","status":"completed"}',
    "",
  ].join("\n"));

  assert.deepEqual(await readPipelineEvents(logPath, { limit: 1 }), [
    { timestamp: "latest", stage: "render", status: "completed" },
  ]);
});

test("records failed terminal status when an operation returns failures", async () => {
  const { runLoggedStage } = pipelineLoggerApi;
  assert.equal(typeof runLoggedStage, "function");

  const events = [];
  const result = await runLoggedStage({
    logger: { event: async (event) => events.push(event) },
    stage: "render-and-queue",
    runId: "run-1",
    operation: async () => ({ packages: { failed: 1 }, treatments: { failed: 0 } }),
    hasFailures: (value) => value.packages.failed > 0 || value.treatments.failed > 0,
  });

  assert.equal(result.packages.failed, 1);
  assert.deepEqual(events.map(({ status }) => status), ["started", "failed"]);
});

test("records completed terminal status when an operation succeeds", async () => {
  const { runLoggedStage } = pipelineLoggerApi;
  assert.equal(typeof runLoggedStage, "function");

  const events = [];
  const result = await runLoggedStage({
    logger: { event: async (event) => events.push(event) },
    stage: "transcript-sync",
    runId: "run-1",
    operation: async () => ({ analyzed: [] }),
    hasFailures: (value) => value.analyzed.some(({ status }) => status === "failed"),
  });

  assert.deepEqual(result, { analyzed: [] });
  assert.deepEqual(events.map(({ status }) => status), ["started", "completed"]);
});

test("records failed terminal status and rethrows stage exceptions", async () => {
  const { runLoggedStage } = pipelineLoggerApi;
  assert.equal(typeof runLoggedStage, "function");

  const events = [];
  const failure = new Error("stage failed");
  await assert.rejects(runLoggedStage({
    logger: { event: async (event) => events.push(event) },
    stage: "transcript-sync",
    runId: "run-1",
    operation: async () => { throw failure; },
  }), (error) => error === failure);

  assert.deepEqual(events.map(({ status }) => status), ["started", "failed"]);
});

test("a rejected stage-event write does not prevent or replace stage work", async () => {
  const { runLoggedStage } = pipelineLoggerApi;
  assert.equal(typeof runLoggedStage, "function");

  let ran = false;
  const result = await runLoggedStage({
    logger: { event: async () => { throw new Error("disk full"); } },
    stage: "render-and-queue",
    runId: "run-1",
    operation: async () => { ran = true; return { completed: true }; },
  });

  assert.equal(ran, true);
  assert.deepEqual(result, { completed: true });
});
