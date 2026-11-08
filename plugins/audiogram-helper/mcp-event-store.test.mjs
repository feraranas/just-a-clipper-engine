import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createJobStore } from "./job-store.mjs";
import { projectStageFact } from "./mcp-event-contract.mjs";

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "mcp-events-store-"));
  const filename = join(dir, "jobs.sqlite");
  const stores = [];
  const open = (overrides = {}) => {
    const store = createJobStore(filename, { ...options, ...overrides });
    stores.push(store);
    return store;
  };
  t.after(async () => {
    for (const store of stores) store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { filename, dir, open, store: open() };
}
const makeJob = (store, videoId = "video") =>
  store.createOrGetJob({ videoId, sourceUrl: "https://youtu.be/abcdefghijk" })
    .job;
const emission = (job, status = "started", stageInstanceId = randomUUID()) => {
  const sourceId = randomUUID();
  return {
    jobId: job.jobId,
    sourceId,
    fact: projectStageFact({
      job,
      sourceId,
      stageInstanceId,
      normalized: { stage: "selection", status },
    }),
  };
};
const failed = {
  status: "failed",
  artifacts: [],
  failures: [
    {
      stage: "selection",
      code: "SELECTION_FAILED",
      message: "Selection failed.",
    },
  ],
};

test("migration is repeatable, preserves legacy results and only assigns legacy owners in explicit private mode", async (t) => {
  const { filename, store, open, dir } = await fixture(t);
  const job = makeJob(store);
  store.setResult(job.jobId, failed);
  const two = open();
  assert.equal(two.getJob(job.jobId).runId, job.jobId);
  assert.equal(two.getJob(job.jobId).ownerId, null);
  assert.deepEqual(two.getJob(job.jobId).result, failed);
  assert.deepEqual(two.listJobEvents({ jobId: job.jobId }), []);
  const privateStore = open({
    eventOwnerMode: "private-tunnel",
    ownerId: "local-owner",
  });
  assert.equal(privateStore.getJob(job.jobId).ownerId, "local-owner");
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  for (const suffix of ["", "-wal", "-shm"])
    assert.equal((await stat(filename + suffix)).mode & 0o777, 0o600);
});

test("two connections allocate stable sequences and duplicate source writes reuse identity", async (t) => {
  const { store, open } = await fixture(t);
  const two = open({ busyTimeoutMs: 100 });
  const job = makeJob(store);
  const input = emission(job);
  const first = store.appendProgress(input);
  assert.equal(first.created, true);
  assert.equal(first.event.data.sequence, 1);
  const duplicate = two.appendProgress(input);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.event.eventId, first.event.eventId);
  assert.throws(
    () => two.appendProgress({ ...input, fact: { ...input.fact, count: 1 } }),
    /conflict/i,
  );
  const next = two.appendProgress(emission(job, "completed"));
  assert.equal(next.event.data.sequence, 2);
  assert.equal(
    store.getEvent(first.event.eventId).eventId,
    first.event.eventId,
  );
  assert.deepEqual(
    store
      .listJobEvents({ jobId: job.jobId, afterSequence: 1, limit: 10 })
      .map((e) => e.data.sequence),
    [2],
  );
  assert.equal(store.getJob(job.jobId).lastEventSequence, 2);
});

test("unknown jobs, mismatched identities, invalid facts and query arguments reject without writes", async (t) => {
  const { store } = await fixture(t);
  const job = makeJob(store);
  const input = emission(job);
  assert.throws(
    () => store.appendProgress({ ...input, jobId: randomUUID() }),
    /not found/i,
  );
  assert.throws(
    () => store.appendProgress({ ...input, sourceId: randomUUID() }),
    /identity/i,
  );
  assert.throws(() =>
    store.appendProgress({
      ...input,
      fact: { ...input.fact, secret: "private" },
    }),
  );
  assert.throws(() => store.listJobEvents({ jobId: job.jobId, limit: 0 }));
  assert.throws(() =>
    store.listJobEvents({ jobId: job.jobId, name: "audiogram.job.fake" }),
  );
  assert.throws(() =>
    store.listJobEvents({ jobId: job.jobId, afterSequence: -1 }),
  );
  assert.equal(store.getJob(job.jobId).lastEventSequence, 0);
});

test("final result and finish event commit atomically and identical final writes are idempotent", async (t) => {
  const { store, open } = await fixture(t);
  const job = makeJob(store);
  store.appendProgress(emission(job));
  const first = store.finalizeJob(job.jobId, failed, { capture: "incomplete" });
  assert.equal(first.job.status, "failed");
  assert.equal(first.event.data.sequence, 2);
  assert.equal(first.event.data.progress_history, "incomplete");
  assert.equal(first.created, true);
  const duplicate = open().finalizeJob(job.jobId, failed, {
    capture: "incomplete",
  });
  assert.equal(duplicate.event.eventId, first.event.eventId);
  assert.equal(duplicate.created, false);
  assert.throws(
    () =>
      store.finalizeJob(
        job.jobId,
        { ...failed, error: "different" },
        { capture: "incomplete" },
      ),
    /conflict/i,
  );
  assert.throws(() => store.appendProgress(emission(job)), /finalized/i);
  assert.equal(
    store.listJobEvents({ jobId: job.jobId, name: "audiogram.job.finished" })
      .length,
    1,
  );
  assert.equal(store.getCaptureHealth(job.jobId), "incomplete");
});

test("SQL failure between result update and event insertion rolls back both, including sequence", async (t) => {
  const { store, filename } = await fixture(t);
  const job = makeJob(store);
  const raw = new DatabaseSync(filename);
  t.after(() => raw.close());
  raw.exec(
    "CREATE TRIGGER fail_finish BEFORE INSERT ON event_outbox WHEN NEW.event_name='audiogram.job.finished' BEGIN SELECT RAISE(ABORT,'injected failure'); END",
  );
  assert.throws(
    () => store.finalizeJob(job.jobId, failed, { capture: "complete" }),
    /injected failure/,
  );
  assert.equal(store.getJob(job.jobId).status, "queued");
  assert.equal(store.getJob(job.jobId).result, undefined);
  assert.equal(store.getJob(job.jobId).lastEventSequence, 0);
  assert.deepEqual(store.listJobEvents({ jobId: job.jobId }), []);
  raw.exec("DROP TRIGGER fail_finish");
  assert.equal(
    store.finalizeJob(job.jobId, failed, { capture: "complete" }).event.data
      .sequence,
    1,
  );
});

test("invalid artifact results and oversized facts cannot finalize a job or allocate a sequence", async (t) => {
  const { store } = await fixture(t);
  const job = makeJob(store);
  for (const result of [
    { status: "complete", artifacts: [] },
    { status: "complete", artifacts: ["/private/secret.mp4"] },
    { status: "partial", artifacts: [], failures: failed.failures },
    {
      status: "complete",
      artifacts: Array(600).fill(
        `artifacts/${"a".repeat(64)}/${"b".repeat(64)}/video.mp4`,
      ),
    },
  ]) {
    assert.throws(() =>
      store.finalizeJob(job.jobId, result, { capture: "complete" }),
    );
  }
  assert.equal(store.getJob(job.jobId).status, "queued");
  assert.equal(store.getJob(job.jobId).lastEventSequence, 0);
});

test("events-enabled compatibility writes finalize atomically while feature-off legacy rows get no invented history", async (t) => {
  const { store, open } = await fixture(t);
  const legacy = makeJob(store);
  store.setFailed(legacy.jobId, "Legacy failure");
  assert.deepEqual(store.listJobEvents({ jobId: legacy.jobId }), []);
  assert.equal(store.getCaptureHealth(legacy.jobId), "unknown");
  const enabled = open({ eventsEnabled: true });
  const job = makeJob(enabled, "second");
  enabled.setResult(job.jobId, failed);
  assert.equal(enabled.listJobEvents({ jobId: job.jobId }).length, 1);
  assert.equal(enabled.getCaptureHealth(job.jobId), "unknown");
  const third = makeJob(enabled, "third");
  enabled.setFailed(third.jobId, "Worker stopped");
  assert.equal(
    enabled.listJobEvents({ jobId: third.jobId })[0].data.status,
    "failed",
  );
});

test("feature-off compatibility writes cannot overwrite an already finalized result", async (t) => {
  const { store } = await fixture(t);
  const job = makeJob(store);
  store.finalizeJob(job.jobId, failed, { capture: "incomplete" });
  assert.throws(
    () =>
      store.setResult(job.jobId, {
        status: "failed",
        artifacts: [],
        error: "overwrite",
      }),
    /conflict/i,
  );
  assert.throws(() => store.setFailed(job.jobId, "overwrite"), /conflict/i);
  assert.equal(store.setResult(job.jobId, failed).created, false);
  assert.deepEqual(store.getJob(job.jobId).result, failed);
});
