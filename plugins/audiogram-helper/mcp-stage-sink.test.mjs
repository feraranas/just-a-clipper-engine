import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobStore } from "./job-store.mjs";
import { createJobDiagnostics } from "./job-diagnostics.mjs";
import { createStageEventSink } from "./mcp-stage-sink.mjs";
import {
  createPipelineLogger,
  readPipelineEvents,
  runLoggedStage,
} from "../../scripts/pipeline-logger.mjs";

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), "mcp-stage-sink-"));
  const store = createJobStore(join(root, "jobs.sqlite"));
  const job = store.createOrGetJob({
    videoId: "video",
    sourceUrl: "https://youtu.be/abcdefghijk",
  }).job;
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const sink = createStageEventSink({ store, job });
  const logPath = join(root, "pipeline.jsonl");
  const logger = createPipelineLogger({ logPath, durableSink: sink });
  return { root, store, job, sink, logPath, logger };
}

test("managed diagnostics reject a caller identity mismatch instead of relabeling it", async (t) => {
  const { root, store, job, sink } = await setup(t);
  const diagnostics = createJobDiagnostics({ projectRoot: root, jobId: job.jobId, durableSink: sink });
  await diagnostics.logger.event({ stage: "render", status: "completed", jobId: randomUUID() });
  assert.equal(sink.captureState(), "incomplete");
  assert.deepEqual(store.listJobEvents({ jobId: job.jobId }), []);
  assert.deepEqual(await diagnostics.readEvents(), []);
  assert.equal(diagnostics.diagnosticsIncomplete, false);
});

test("one logger emission reaches the durable store and JSONL with the same stable source identity", async (t) => {
  const { store, job, sink, logger, logPath } = await setup(t);
  await logger.event({
    stage: "transcript",
    status: "completed",
    jobId: job.jobId,
    runId: job.jobId,
    transcript: "private",
    message: "secret",
    count: 12,
  });
  const [mirror] = await readPipelineEvents(logPath);
  assert.equal(typeof mirror.sourceId, "string");
  assert.equal(typeof mirror.stageInstanceId, "string");
  assert.equal((await sink.record(mirror)).persisted, true);
  await sink.flush();
  const events = store.listJobEvents({ jobId: job.jobId });
  assert.equal(events.length, 1);
  assert.equal(events[0].data.count, 12);
  assert.equal(sink.captureState(), "complete");
  assert.equal(JSON.stringify(events).includes("private"), false);
  await writeFile(logPath, "");
  assert.equal(store.listJobEvents({ jobId: job.jobId }).length, 1);
});

test("concurrent stage invocations have separate identity and bounded recovery retains its invocation", async (t) => {
  const { store, job, logger } = await setup(t);
  await Promise.all(
    [1, 2].map((clipPackageId) =>
      runLoggedStage({
        logger,
        stage: "selection",
        jobId: job.jobId,
        runId: job.jobId,
        clipPackageId,
        operation: async (context) => {
          context.stageAttempt = 2;
          await logger.event({
            jobId: job.jobId,
            runId: job.jobId,
            stage: "selection",
            status: "retrying",
            stageInstanceId: context.stageInstanceId,
            stageAttempt: context.stageAttempt,
            clipPackageId,
            errorCode: "SELECTION_INVALID_CUE",
          });
        },
      }),
    ),
  );
  const events = store.listJobEvents({ jobId: job.jobId });
  assert.equal(events.length, 6);
  const instances = new Set(
    events.map((event) => event.data.stage_instance_id),
  );
  assert.equal(instances.size, 2);
  for (const id of instances) {
    const invocation = events.filter(
      (event) => event.data.stage_instance_id === id,
    );
    assert.deepEqual(
      invocation.map((event) => event.data.kind),
      ["stage_started", "stage_recovery", "stage_completed"],
    );
    assert.deepEqual(
      invocation.map((event) => event.data.stage_attempt),
      [1, 2, 2],
    );
  }
});

test("bounded SQL retries latch incomplete capture without failing pipeline execution", async (t) => {
  const { store, job, logPath } = await setup(t);
  const waits = [];
  let calls = 0;
  const sink = createStageEventSink({
    job,
    store: {
      appendProgress() {
        calls++;
        throw new Error("SQLITE_BUSY");
      },
    },
    sleep: async (ms) => waits.push(ms),
  });
  const logger = createPipelineLogger({ logPath, durableSink: sink });
  assert.equal(
    await runLoggedStage({
      logger,
      stage: "render",
      operation: async () => 42,
    }),
    42,
  );
  assert.equal(calls, 6);
  assert.deepEqual(waits, [50, 100, 50, 100]);
  assert.equal(sink.captureState(), "incomplete");
  assert.equal((await readPipelineEvents(logPath)).length, 2);
  assert.deepEqual(store.listJobEvents({ jobId: job.jobId }), []);
});

test("mirror truncation is separate from durable capture health", async (t) => {
  const { store, job, sink, logPath } = await setup(t);
  let mirrorFailed = false;
  const logger = createPipelineLogger({
    logPath,
    durableSink: sink,
    maxFileBytes: 1,
    onError: () => {
      mirrorFailed = true;
    },
  });
  await logger.event({ stage: "jev", status: "skipped" });
  assert.equal(mirrorFailed, true);
  assert.equal(sink.captureState(), "complete");
  assert.equal(
    store.listJobEvents({ jobId: job.jobId })[0].data.kind,
    "stage_skipped",
  );
});

test("mismatched identity and late writes do not reach the store and closing flushes pending records", async (t) => {
  const { store, job, sink } = await setup(t);
  const input = {
    stage: "transcript",
    status: "started",
    sourceId: randomUUID(),
    stageInstanceId: randomUUID(),
    jobId: randomUUID(),
  };
  assert.equal((await sink.record(input)).persisted, false);
  assert.equal(sink.captureState(), "incomplete");
  const pending = sink.record({ ...input, jobId: job.jobId });
  await sink.close();
  assert.equal((await pending).persisted, true);
  assert.equal(
    (await sink.record({ ...input, jobId: job.jobId, sourceId: randomUUID() }))
      .persisted,
    false,
  );
  assert.equal(store.listJobEvents({ jobId: job.jobId }).length, 1);
});
