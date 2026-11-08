import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Webhook } from "standardwebhooks";
import { createJobStore } from "./job-store.mjs";
import { createStageEventSink } from "./mcp-stage-sink.mjs";
import { createEventMethods } from "./mcp-events.mjs";
import { createEventSecrets } from "./mcp-event-secrets.mjs";
import { createWebhookClient } from "./mcp-webhook.mjs";
import { dispatcherTick } from "./mcp-event-dispatcher.mjs";
import {
  validateCliResult,
  validateStoredResult,
} from "./result-validation.mjs";
import {
  createPipelineLogger,
  runLoggedStage,
} from "../../scripts/pipeline-logger.mjs";

// These tests compose existing production components. The receiver is not
// ChatGPT and the fixture bytes are not proof of a working video renderer.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mcp-chat-workflow-"));
  const principal = { id: "local-owner" };
  let now = Date.now();
  const store = createJobStore(join(root, "jobs.sqlite"), {
    ownerId: principal.id,
    now: () => new Date(now).toISOString(),
  });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const job = store.createOrGetJob({
    videoId: "synthetic",
    sourceUrl: "https://youtu.be/abcdefghijk",
  }).job;
  const sink = createStageEventSink({ store, job });
  const logger = createPipelineLogger({
    logPath: join(root, "pipeline.jsonl"),
    durableSink: sink,
  });
  const secrets = createEventSecrets({ key: Buffer.alloc(32, 6) });
  const secret = `whsec_${Buffer.alloc(32, 8).toString("base64")}`;
  const verifier = new Webhook(secret);
  const receipts = [],
    attempts = [];
  let blockProgress = false;
  let loseReceipt = false;
  const webhook = createWebhookClient({
    clock: () => now,
    transport: async ({ headers, body }) => {
      const event = verifier.verify(body, headers);
      assert.equal(typeof headers["X-MCP-Subscription-Id"], "string");
      if (event.type === "verification")
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ challenge: event.challenge }),
        };
      attempts.push(event);
      if (blockProgress && event.name === "audiogram.job.progress")
        return { status: 503, headers: {}, body: "{}" };
      receipts.push(event);
      if (loseReceipt) {
        loseReceipt = false;
        throw new Error("response lost after receipt");
      }
      return { status: 200, headers: {}, body: "{}" };
    },
  });
  const validateResult = (result) => validateStoredResult(result, root);
  const methods = createEventMethods({
    store,
    secrets,
    webhook,
    clock: () => now,
    validateResult,
  });
  const subscribe = async (name) =>
    methods.handleEventRequest({
      principal,
      method: "events/subscribe",
      params: {
        name,
        arguments: { job_id: job.jobId },
        delivery: {
          mode: "webhook",
          url: "https://receiver.example.com/callback",
          secret,
        },
        cursor: null,
      },
    });
  const tick = () =>
    dispatcherTick({
      store,
      secrets,
      webhook,
      clock: () => now,
      random: () => 0,
      validateResult,
    });
  const drain = async () => {
    for (let i = 0; i < 50; i++) {
      if (!(await tick()).claimed) return;
    }
    throw new Error("delivery did not drain");
  };
  const stage = (stage, operation = async () => {}, extra = {}) =>
    runLoggedStage({
      logger,
      stage,
      jobId: job.jobId,
      runId: job.runId,
      operation,
      ...extra,
    });
  const finish = async (status) => {
    const artifactPaths = [];
    if (["complete", "partial"].includes(status)) {
      await mkdir(join(root, "out", "treatments"), { recursive: true });
      await writeFile(
        join(root, "out", "treatments", "clip.mp4"),
        "synthetic-fixture-bytes",
      );
      artifactPaths.push("out/treatments/clip.mp4");
    }
    const failures = ["partial", "failed"].includes(status)
      ? [
          {
            stage: "render",
            code: "RENDER_FAILED",
            message: "Render failed.",
            packageId: "A",
          },
        ]
      : [];
    const result = await validateCliResult(
      { contractVersion: 1, status, artifactPaths, failures },
      root,
      { recordArtifactHashes: true },
    );
    await sink.flush();
    store.finalizeJob(job.jobId, result, { capture: sink.captureState() });
  };
  return {
    root,
    store,
    job,
    sink,
    logger,
    receipts,
    attempts,
    subscribe,
    tick,
    drain,
    stage,
    finish,
    advance: (ms) => {
      now += ms;
    },
    block: (value) => {
      blockProgress = value;
    },
    loseNextReceipt: () => {
      loseReceipt = true;
    },
  };
}

for (const status of ["complete", "partial", "failed", "no_clips"])
  test(`synthetic ${status} traverses logger, durable facts and signed late-subscription replay`, async (t) => {
    const f = await fixture(t);
    await f.stage("transcript");
    await f.stage("selection", async (context) => {
      context.stageAttempt = 2;
      await f.logger.event({
        stage: "selection",
        status: "retrying",
        jobId: f.job.jobId,
        runId: f.job.runId,
        stageInstanceId: context.stageInstanceId,
        stageAttempt: 2,
        errorCode: "SELECTION_INVALID_CUE",
      });
    });
    await f.logger.event({
      stage: "jev",
      status: "skipped",
      jobId: f.job.jobId,
      runId: f.job.runId,
    });
    if (status !== "no_clips") {
      await f.stage("assets");
      if (["partial", "failed"].includes(status))
        await assert.rejects(
          f.stage(
            "render",
            async () => {
              throw new Error("synthetic error");
            },
            { clipPackageId: "A" },
          ),
        );
      else await f.stage("render", undefined, { clipPackageId: "A" });
      if (status !== "failed")
        await f.stage("render", undefined, { clipPackageId: "B" });
      await f.stage("artifact_verification");
    }
    await f.finish(status);
    // Job already finished: new subscriptions must still receive retained facts.
    await f.subscribe("audiogram.job.progress");
    await f.subscribe("audiogram.job.finished");
    await f.drain();
    const progress = f.receipts.filter(
      (event) => event.name === "audiogram.job.progress",
    );
    assert.deepEqual(
      progress
        .filter((event) => event.data.stage === "selection")
        .map((event) => event.data.kind),
      ["stage_started", "stage_recovery", "stage_completed"],
    );
    assert.equal(
      new Set(
        progress
          .filter((event) => event.data.stage === "selection")
          .map((event) => event.data.stage_instance_id),
      ).size,
      1,
    );
    assert.deepEqual(
      progress
        .filter((event) => event.data.stage === "jev")
        .map((event) => event.data.kind),
      ["stage_skipped"],
    );
    assert.ok(
      progress.every(
        (event, index) =>
          index === 0 ||
          event.data.sequence > progress[index - 1].data.sequence,
      ),
    );
    if (["complete", "partial"].includes(status)) {
      const renders = progress.filter((event) => event.data.stage === "render");
      assert.deepEqual(
        [...new Set(renders.map((event) => event.data.clip_package_id))].sort(),
        ["A", "B"],
      );
      assert.equal(
        new Set(renders.map((event) => event.data.stage_instance_id)).size,
        2,
      );
    }
    const finished = f.receipts.filter(
      (event) => event.name === "audiogram.job.finished",
    );
    assert.equal(finished.length, 1);
    assert.equal(finished[0].data.status, status);
    assert.equal(finished[0].data.progress_history, "complete");
    assert.equal(
      finished[0].data.artifacts.length,
      ["complete", "partial"].includes(status) ? 1 : 0,
    );
    assert.deepEqual(
      finished[0].data.failures.map((failure) => failure.clip_package_id),
      ["partial", "failed"].includes(status) ? ["A"] : [],
    );
    assert.equal(f.store.getJob(f.job.jobId).status, status);
    assert.equal(
      new Set(f.receipts.map((event) => event.eventId)).size,
      f.receipts.length,
    );
    assert.equal(JSON.stringify(f.receipts).includes("synthetic error"), false);
    const count = f.receipts.length;
    await f.subscribe("audiogram.job.progress");
    await f.subscribe("audiogram.job.finished");
    await f.drain();
    assert.equal(
      f.receipts.length,
      count,
      "refresh must not replay acknowledged facts",
    );
  });

test("finish can arrive before delayed progress and lost acknowledgments preserve duplicate event identity", async (t) => {
  const f = await fixture(t);
  await f.subscribe("audiogram.job.progress");
  await f.subscribe("audiogram.job.finished");
  await f.stage("transcript");
  await f.finish("no_clips");
  f.block(true);
  await f.tick();
  assert.deepEqual(
    f.receipts.map((event) => event.name),
    ["audiogram.job.finished"],
  );
  const finalSequence = f.receipts[0].data.sequence;
  f.block(false);
  f.advance(5000);
  f.loseNextReceipt();
  await f.tick();
  f.advance(10000);
  await f.drain();
  const progress = f.receipts.filter(
    (event) => event.name === "audiogram.job.progress",
  );
  assert.equal(progress.length, 3);
  assert.equal(progress[0].eventId, progress[1].eventId);
  assert.deepEqual(progress[0], progress[1]);
  assert.ok(progress.every((event) => event.data.sequence < finalSequence));
  assert.equal(f.store.getJob(f.job.jobId).status, "no_clips");
});
