import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPipelineLogger,
  readPipelineEvents,
  runLoggedStage,
} from "./pipeline-logger.mjs";

const fixture = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pipeline-log-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "events.jsonl");
};

test("logger preserves structured metadata but excludes arbitrary payloads", async (t) => {
  const logPath = await fixture(t);
  const logger = createPipelineLogger({
    logPath,
    now: () => "2026-10-02T12:00:00Z",
  });
  await logger.event({
    stage: "render",
    status: "completed",
    jobId: "7bb07aec-e580-4ca4-a2fe-d96bc02b8035",
    clipPackageId: 42,
    durationMs: 50,
    message: "secret",
    transcript: "private",
  });
  assert.deepEqual(await readPipelineEvents(logPath), [
    {
      timestamp: "2026-10-02T12:00:00Z",
      stage: "render",
      status: "completed",
      jobId: "7bb07aec-e580-4ca4-a2fe-d96bc02b8035",
      clipPackageId: 42,
      durationMs: 50,
    },
  ]);
});

test("write and diagnostic failures cannot fail pipeline work", async (t) => {
  const logPath = await fixture(t);
  await writeFile(logPath, "not a directory");
  const logger = createPipelineLogger({
    logPath: join(logPath, "events"),
    onError: async () => {
      throw Error("diagnostic failed");
    },
  });
  assert.equal(
    await runLoggedStage({
      logger,
      stage: "render",
      operation: async () => 42,
    }),
    42,
  );
});

test("reader tolerates malformed and interrupted records and resumes after append", async (t) => {
  const logPath = await fixture(t);
  const old = { stage: "render", status: "started", runId: "old" };
  await writeFile(logPath, JSON.stringify(old) + '\nnull\n{bad}\n{"stage":');
  await createPipelineLogger({ logPath }).event({
    stage: "render",
    status: "completed",
    jobId: "7bb07aec-e580-4ca4-a2fe-d96bc02b8035",
    runId: "new",
  });
  assert.deepEqual(
    (await readPipelineEvents(logPath)).map((event) => event.runId),
    ["new", "old"],
  );
  assert.equal((await readPipelineEvents(logPath, { limit: 1 })).length, 1);
});

test("bounded tail skips giant records and validates limits", async (t) => {
  const logPath = await fixture(t);
  await writeFile(
    logPath,
    "x".repeat(9 * 1024 * 1024) + '\n{"stage":"render","status":"completed"}\n',
  );
  assert.equal((await readPipelineEvents(logPath, { limit: 1000 })).length, 1);
  for (const limit of [0, -1, 1001, 1.5, NaN])
    await assert.rejects(readPipelineEvents(logPath, { limit }));
  assert.deepEqual(await readPipelineEvents(logPath + ".missing"), []);
});

test("returned failures and thrown failures have accurate terminal events", async () => {
  const events = [];
  const logger = { event: async (event) => events.push(event) };
  await runLoggedStage({
    logger,
    stage: "pipeline",
    operation: async () => ({ failed: true }),
    hasFailures: (result) => result.failed,
    failureStatus: "partial",
  });
  assert.deepEqual(
    events.map((event) => event.status),
    ["started", "partial"],
  );
  const original = Error("private error payload");
  await assert.rejects(
    runLoggedStage({
      logger,
      stage: "render",
      operation: async () => {
        throw original;
      },
    }),
    (error) => error === original,
  );
  assert.equal(events.at(-1).status, "failed");
  assert.equal(events.at(-1).errorCode, "operation_failed");
  assert.ok(!JSON.stringify(events).includes("private"));
});
