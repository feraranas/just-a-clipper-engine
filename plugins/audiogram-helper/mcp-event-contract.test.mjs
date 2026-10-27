import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EVENT_NAMES,
  PROGRESS_KINDS,
  TERMINAL_STATUSES,
  ProgressDataSchema,
  FinishedDataSchema,
  EventEnvelopeSchema,
  projectStageFact,
  buildProgressEvent,
  buildJobFinishedEvent,
  toWebhookEnvelope,
} from "./mcp-event-contract.mjs";

const job = { jobId: "11111111-1111-4111-8111-111111111111" };
const parentId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const stageInstanceId = "44444444-4444-4444-8444-444444444444";
const eventId = "55555555-5555-4555-8555-555555555555";
const timestamp = "2026-10-26T12:00:00.000Z";
const artifact = `artifacts/${"a".repeat(64)}/${"b".repeat(64)}/video.mp4`;
const fact = (normalized = {}, extra = {}) =>
  projectStageFact({
    job,
    sourceId,
    stageInstanceId,
    normalized: { stage: "selection", status: "started", ...normalized },
    ...extra,
  });
const progress = (overrides = {}) =>
  buildProgressEvent({
    job,
    fact: fact(),
    eventId,
    sequence: 1,
    timestamp,
    ...overrides,
  });
const finished = (result, overrides = {}) =>
  buildJobFinishedEvent({
    job,
    result,
    eventId,
    sequence: 2,
    timestamp,
    capture: "complete",
    ...overrides,
  });

test("logger transitions create progress only, including recovery and explicit skipped Jev", () => {
  const cases = [
    ["started", "stage_started"],
    ["completed", "stage_completed"],
    ["failed", "stage_failed"],
    ["retrying", "stage_recovery"],
    ["skipped", "stage_skipped"],
  ];
  assert.deepEqual(EVENT_NAMES, [
    "audiogram.job.progress",
    "audiogram.job.finished",
  ]);
  assert.deepEqual(
    PROGRESS_KINDS,
    cases.map(([, kind]) => kind),
  );
  for (const [status, kind] of cases) {
    const event = progress({ fact: fact({ stage: "jev", status }) });
    assert.equal(event.name, "audiogram.job.progress");
    assert.equal(event.data.kind, kind);
    assert.equal(event.data.stage, "jev");
    assert.equal(event.data.stage_instance_id, stageInstanceId);
    assert.equal(event.data.status, undefined);
    assert.equal(event.data.failures, undefined);
    if (status === "skipped") assert.equal(event.data.code, undefined);
  }
});

test("projection exposes fixed messages and known codes, not raw content", () => {
  const secret = "sk-private-secret /Users/kiwi/private transcript text";
  const projected = fact({
    status: "retrying",
    errorCode: "SELECTION_INVALID_CUE",
    message: secret,
    transcript: secret,
    error: secret,
    title: secret,
    secret,
  });
  const event = progress({ fact: projected });
  assert.equal(event.data.code, "SELECTION_INVALID_CUE");
  assert.equal(event.data.message, "Selection is recovering within this job.");
  assert.equal(JSON.stringify(event).includes(secret), false);
  const unknown = progress({
    fact: fact({ status: "failed", errorCode: "SENSITIVE_CUSTOMER_NAME" }),
  });
  assert.equal(unknown.data.code, "SELECTION_FAILED");
});

test("distinct packages keep identity and recovery keeps its stage instance without guessing attempts", () => {
  const first = fact({
    clipPackageId: 12,
    treatmentId: "classic-v1",
    count: 7,
  });
  const recovery = fact(
    { status: "retrying", clipPackageId: 12, treatmentId: "classic-v1" },
    { stageAttempt: 2 },
  );
  const second = fact(
    { clipPackageId: "13", treatmentId: "other-v1" },
    { stageInstanceId: parentId },
  );
  assert.equal(first.clip_package_id, "12");
  assert.equal(first.treatment_id, "classic-v1");
  assert.equal(first.stage_attempt, undefined);
  assert.equal(recovery.stage_instance_id, first.stage_instance_id);
  assert.equal(recovery.stage_attempt, 2);
  assert.notEqual(second.stage_instance_id, first.stage_instance_id);
  assert.notEqual(second.clip_package_id, first.clip_package_id);
});

test("internal diagnostics are ignored, but unknown stages, statuses and mismatched job context reject", () => {
  for (const stage of ["queue", "videos-pending", "video-analysis"])
    assert.equal(fact({ stage }), null);
  for (const normalized of [
    { stage: "made_up" },
    { status: "made_up" },
    { jobId: parentId },
    { runId: parentId },
    { clipPackageId: "/Users/kiwi/private" },
    { treatmentId: "../private" },
    { durationMs: -1 },
    { count: 1.5 },
  ])
    assert.throws(() => fact(normalized));
  assert.throws(() => fact({}, { sourceId: "not-a-uuid" }));
  assert.throws(() => fact({}, { stageAttempt: 0 }));
  assert.throws(() => fact({}, { job: { ...job, runId: parentId } }));
});

test("strict progress schema rejects invented fields, invalid identity, measurements, messages and kinds", () => {
  const data = progress().data;
  for (const patch of [
    { kind: "stage_maybe" },
    { stage: "made_up" },
    { job_id: "job-a" },
    { run_id: parentId },
    { parent_job_id: job.jobId },
    { stage_instance_id: "bad" },
    { sequence: 0 },
    { sequence: 1.5 },
    { stage_attempt: -1 },
    { duration_ms: Infinity },
    { count: -1 },
    { message: "arbitrary raw text" },
    { transcript: "secret" },
    { code: "SECRET_PROVIDER_TEXT" },
  ])
    assert.equal(
      ProgressDataSchema.safeParse({ ...data, ...patch }).success,
      false,
    );
  assert.throws(() => progress({ fact: { ...fact(), rawLog: "secret" } }));
  assert.throws(() => progress({ job: { jobId: parentId } }));
});

test("finish builder supports every terminal status and preserves every package failure safely", () => {
  assert.deepEqual(TERMINAL_STATUSES, [
    "complete",
    "partial",
    "failed",
    "no_clips",
  ]);
  const failures = [
    {
      stage: "assets",
      packageId: "clip-1",
      code: "ASSET_FAILED",
      message: "secret one",
    },
    {
      stage: "render",
      packageId: "clip-2",
      code: "RENDER_FAILED",
      message: "secret two",
    },
  ];
  for (const status of TERMINAL_STATUSES) {
    const event = finished(
      {
        status,
        artifacts: ["complete", "partial"].includes(status) ? [artifact] : [],
        failures: ["failed", "partial"].includes(status) ? failures : [],
      },
      { job: { ...job, retryOfJobId: parentId }, capture: "incomplete" },
    );
    assert.equal(event.name, "audiogram.job.finished");
    assert.equal(event.data.status, status);
    assert.equal(event.data.parent_job_id, parentId);
    assert.equal(event.data.progress_history, "incomplete");
    assert.equal(JSON.stringify(event).includes("secret"), false);
    if (["failed", "partial"].includes(status)) {
      assert.deepEqual(
        event.data.failures.map((item) => item.clip_package_id),
        ["clip-1", "clip-2"],
      );
      assert.equal(event.data.failures[1].message, "Rendering failed.");
    }
  }
});

test("final results enforce artifact and failure rules without accepting stage completions", () => {
  for (const result of [
    {
      status: "partial",
      artifacts: [],
      failures: [{ stage: "render", code: "RENDER_FAILED" }],
    },
    { status: "partial", artifacts: [artifact], failures: [] },
    { status: "complete", artifacts: [] },
    {
      status: "complete",
      artifacts: [artifact],
      failures: [{ stage: "render", code: "RENDER_FAILED" }],
    },
    { status: "failed", artifacts: [artifact] },
    { status: "no_clips", artifacts: [artifact] },
    {
      status: "no_clips",
      artifacts: [],
      failures: [{ stage: "jev", code: "JEV_FAILED" }],
    },
    { status: "completed", stage: "render" },
    { status: "running", artifacts: [] },
    { status: "complete", artifactPaths: [artifact] },
  ])
    assert.throws(() => finished(result));
  assert.equal(
    finished({ status: "failed", artifacts: [] }, { capture: "unknown" }).data
      .progress_history,
    "unknown",
  );
  assert.throws(() =>
    finished({ status: "failed", artifacts: [] }, { capture: "maybe" }),
  );
  assert.throws(() =>
    finished({
      status: "failed",
      artifacts: [],
      failures: [{ stage: "invented", code: "FAILED" }],
    }),
  );
});

test("verified result references must be safe artifact references, not arbitrary paths or URLs", () => {
  for (const reference of [
    "/Users/kiwi/private.mp4",
    "https://example.com/video.mp4",
    "out/treatments/../private.mp4",
    "out/treatments//file.mp4",
    "out/treatments/%2e%2e/file.mp4",
    "out/treatments/file\\video.mp4",
    "artifacts/invalid/video.mp4",
    "out/secret.mp4",
  ]) {
    assert.throws(() =>
      finished({ status: "complete", artifacts: [reference] }),
    );
  }
  assert.equal(
    finished({
      status: "complete",
      artifacts: ["out/treatments/clip-1/video.mp4"],
    }).data.artifacts.length,
    1,
  );
});

test("schemas reject unknown final fields and malformed envelopes without leaking secrets", () => {
  const terminal = finished({ status: "complete", artifacts: [artifact] });
  assert.equal(
    FinishedDataSchema.safeParse({ ...terminal.data, rawLog: "secret" })
      .success,
    false,
  );
  for (const patch of [
    { eventId: "bad" },
    { timestamp: "yesterday" },
    { timestamp: "2026-99-99T12:00:00Z" },
    { name: "audiogram.job.failed" },
    { sequence: 1 },
    { secret: "private" },
    { name: "audiogram.job.progress" },
    { cursor: "https://callback.example/private?secret=x" },
  ])
    assert.equal(
      EventEnvelopeSchema.safeParse({ ...terminal, ...patch }).success,
      false,
    );
  try {
    progress({ fact: { ...fact(), message: "sk-private-secret" } });
    assert.fail("must reject");
  } catch (error) {
    assert.equal(error.message.includes("sk-private-secret"), false);
  }
});

test("webhook projection preserves event identity and checks cursor, strict fields and exact UTF-8 byte limit", () => {
  const event = progress();
  assert.equal(event.cursor, null);
  const envelope = toWebhookEnvelope(event, { cursor: "opaque_cursor-1" });
  assert.equal(envelope.eventId, eventId);
  assert.equal(envelope.data.sequence, 1);
  assert.equal(envelope.cursor, "opaque_cursor-1");
  assert.equal(event.cursor, null);
  assert.throws(() =>
    toWebhookEnvelope({ ...event, secret: "secret" }, { cursor: "ok" }),
  );
  assert.throws(() => toWebhookEnvelope(event, { cursor: "bad\ncursor" }));
  const hugeArtifacts = Array.from({ length: 600 }, () => artifact);
  assert.throws(
    () => finished({ status: "complete", artifacts: hugeArtifacts }),
    /64 KiB/,
  );
  const justValid = finished({
    status: "complete",
    artifacts: Array.from({ length: 400 }, () => artifact),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(justValid)) < 65536);
  const cursorLength =
    65536 - Buffer.byteLength(JSON.stringify({ ...justValid, cursor: "" }));
  const boundary = toWebhookEnvelope(justValid, {
    cursor: "x".repeat(cursorLength),
  });
  assert.equal(Buffer.byteLength(JSON.stringify(boundary)), 65536);
  assert.throws(
    () =>
      toWebhookEnvelope(justValid, { cursor: "x".repeat(cursorLength + 1) }),
    /64 KiB/,
  );
  assert.throws(
    () => toWebhookEnvelope(justValid, { cursor: "x".repeat(8192) }),
    /64 KiB/,
  );
});
