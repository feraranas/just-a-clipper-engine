import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createJobStore } from "./job-store.mjs";
import { createEventSecrets } from "./mcp-event-secrets.mjs";
import { createEventMethods } from "./mcp-events.mjs";
import { projectStageFact } from "./mcp-event-contract.mjs";

const principal = { id: "local-owner" };
const secret = `whsec_${Buffer.alloc(32, 4).toString("base64")}`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mcp-subscriptions-"));
  const file = join(root, "jobs.sqlite");
  let now = Date.parse("2026-10-26T12:00:00Z");
  const store = createJobStore(file, {
    ownerId: principal.id,
    eventOwnerMode: "private-tunnel",
    now: () => new Date(now).toISOString(),
  });
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const job = store.createOrGetJob({
    videoId: "video",
    sourceUrl: "https://youtu.be/abcdefghijk",
  }).job;
  const secrets = createEventSecrets({ key: Buffer.alloc(32, 1) });
  let verifications = 0;
  const webhook = {
    verifyCallback: async () => {
      verifications++;
      return { verified: true };
    },
  };
  const methods = createEventMethods({
    store,
    secrets,
    webhook,
    clock: () => now,
    validateResult: async (result) => result,
  });
  const params = (extra = {}) => ({
    name: "audiogram.job.progress",
    arguments: { job_id: job.jobId },
    delivery: {
      mode: "webhook",
      url: "https://receiver.example.com/callback",
      secret,
    },
    cursor: null,
    ...extra,
  });
  const call = (method, input = {}, who = principal) =>
    methods.handleEventRequest({ principal: who, method, params: input });
  const append = () => {
    const sourceId = randomUUID();
    return store.appendProgress({
      jobId: job.jobId,
      sourceId,
      fact: projectStageFact({
        job,
        sourceId,
        stageInstanceId: randomUUID(),
        normalized: { stage: "selection", status: "started" },
      }),
    });
  };
  return {
    root,
    file,
    store,
    job,
    secrets,
    webhook,
    params,
    call,
    append,
    clock: () => now,
    advance: (ms) => {
      now += ms;
    },
    verifications: () => verifications,
  };
}

test("event catalog exposes only approved job-filtered event definitions to an authenticated account", async (t) => {
  const f = await fixture(t);
  const catalog = await f.call("events/list");
  assert.deepEqual(
    catalog.events.map((event) => event.name),
    ["audiogram.job.progress", "audiogram.job.finished"],
  );
  assert.deepEqual(catalog.events[0].inputSchema.required, ["job_id"]);
  assert.equal(catalog.events[0].payloadSchema.additionalProperties, false);
  await assert.rejects(f.call("events/list", {}, null));
  await assert.rejects(f.call("events/other"));
});

test("subscription verifies before activation and backfills events created before and during verification", async (t) => {
  const f = await fixture(t);
  f.append();
  f.webhook.verifyCallback = async () => {
    f.append();
    return { verified: true };
  };
  const subscribed = await f.call("events/subscribe", f.params());
  assert.match(subscribed.id, /^sub_[a-f0-9]{64}$/);
  assert.equal(subscribed.refreshBefore, "2026-10-27T12:00:00.000Z");
  assert.equal(subscribed.truncated, false);
  const raw = new DatabaseSync(f.file);
  t.after(() => raw.close());
  const row = raw
    .prepare("SELECT * FROM event_subscriptions WHERE id=?")
    .get(subscribed.id);
  assert.equal(row.state, "active");
  assert.equal(JSON.stringify(row).includes(secret), false);
  assert.equal(f.secrets.openSecret(row.secret_box), secret);
  assert.deepEqual(
    raw
      .prepare("SELECT sequence FROM event_deliveries ORDER BY sequence")
      .all()
      .map((row) => row.sequence),
    [1, 2],
  );
  f.append();
  assert.equal(
    raw.prepare("SELECT COUNT(*) AS n FROM event_deliveries").get().n,
    3,
  );
});

test("idempotent refresh caches verification by owner callback and secret, honors finite TTL and preserves identity", async (t) => {
  const f = await fixture(t);
  const first = await f.call("events/subscribe", f.params({ ttlMs: 10000 }));
  assert.equal(first.refreshBefore, "2026-10-26T12:00:10.000Z");
  const second = await f.call("events/subscribe", f.params({ ttlMs: null }));
  assert.equal(first.id, second.id);
  assert.equal(f.verifications(), 1);
  f.advance(300001);
  await f.call("events/subscribe", f.params({ ttlMs: 10 * 86400000 }));
  assert.equal(f.verifications(), 2);
  for (const ttlMs of [0, -1, 1.5])
    await assert.rejects(f.call("events/subscribe", f.params({ ttlMs })));
});

test("invalid filters, cross-owner jobs and unsafe callbacks reject before verification", async (t) => {
  const f = await fixture(t);
  for (const input of [
    f.params({ name: "audiogram.job.fake" }),
    f.params({ arguments: { job_id: f.job.jobId, owner: "forged" } }),
    f.params({ arguments: { job_id: randomUUID() } }),
    f.params({
      delivery: { mode: "webhook", url: "http://localhost/", secret },
    }),
    f.params({
      delivery: {
        mode: "webhook",
        url: "https://receiver.example.com",
        secret: "invalid",
      },
    }),
  ]) {
    await assert.rejects(f.call("events/subscribe", input));
  }
  await assert.rejects(
    f.call("events/subscribe", f.params(), { id: "other-owner" }),
  );
  assert.equal(f.verifications(), 0);
});

test("failed or cancelled verification cannot activate a subscription or create delivery work", async (t) => {
  const f = await fixture(t);
  f.append();
  f.webhook.verifyCallback = async () => {
    throw Object.assign(new Error("private token"), {
      reason: "challenge_failed",
    });
  };
  await assert.rejects(
    f.call("events/subscribe", f.params()),
    (error) => error.code === -32015 && !error.message.includes("private"),
  );
  f.webhook.verifyCallback = async () => {
    await f.call("events/unsubscribe", {
      ...f.params(),
      delivery: {
        mode: "webhook",
        url: "https://receiver.example.com/callback",
      },
    });
    return { verified: true };
  };
  await assert.rejects(f.call("events/subscribe", f.params()));
  const raw = new DatabaseSync(f.file);
  t.after(() => raw.close());
  assert.equal(
    raw.prepare("SELECT COUNT(*) AS n FROM event_deliveries").get().n,
    0,
  );
  assert.equal(
    raw.prepare("SELECT secret_box FROM event_subscriptions").get().secret_box,
    null,
  );
});

test("expired verification and competing renewal cannot activate stale subscription versions", async (t) => {
  const f = await fixture(t);
  f.webhook.verifyCallback = async () => {
    f.advance(1001);
  };
  await assert.rejects(
    f.call("events/subscribe", f.params({ ttlMs: 1000 })),
    /changed before activation/,
  );
  let nested = false;
  const replacement = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
  f.webhook.verifyCallback = async () => {
    if (!nested) {
      nested = true;
      await f.call(
        "events/subscribe",
        f.params({ delivery: { ...f.params().delivery, secret: replacement } }),
      );
    }
  };
  await assert.rejects(
    f.call("events/subscribe", f.params()),
    /changed before activation/,
  );
  const raw = new DatabaseSync(f.file);
  try {
    const row = raw.prepare("SELECT * FROM event_subscriptions").get();
    assert.equal(row.state, "active");
    assert.equal(f.secrets.openSecret(row.secret_box), replacement);
    assert.equal(f.store.getJob(f.job.jobId).status, "queued");
  } finally {
    raw.close();
  }
});

test("secret rotation requires verification and retains old encrypted key for only the overlap window", async (t) => {
  const f = await fixture(t);
  const first = await f.call("events/subscribe", f.params());
  const replacement = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
  await f.call(
    "events/subscribe",
    f.params({ delivery: { ...f.params().delivery, secret: replacement } }),
  );
  assert.equal(f.verifications(), 2);
  const raw = new DatabaseSync(f.file);
  t.after(() => raw.close());
  const row = raw
    .prepare("SELECT * FROM event_subscriptions WHERE id=?")
    .get(first.id);
  assert.equal(f.secrets.openSecret(row.secret_box), replacement);
  assert.equal(f.secrets.openSecret(row.previous_secret_box), secret);
  f.advance(300001);
  f.store.reconcileDeliveries({ now: f.clock() });
  assert.equal(
    raw
      .prepare("SELECT previous_secret_box FROM event_subscriptions WHERE id=?")
      .get(first.id).previous_secret_box,
    null,
  );
});

test("expired and cross-scope cursors cannot skip pending events and retention gaps are explicit", async (t) => {
  const f = await fixture(t);
  f.append();
  f.append();
  const first = await f.call("events/subscribe", f.params());
  const ahead = f.secrets.encodeCursor({
    principalId: principal.id,
    jobId: f.job.jobId,
    name: "audiogram.job.progress",
    sequence: 2,
  });
  const refreshed = await f.call(
    "events/subscribe",
    f.params({ cursor: ahead }),
  );
  assert.equal(
    f.secrets.decodeCursor(refreshed.cursor, {
      principalId: principal.id,
      jobId: f.job.jobId,
      name: "audiogram.job.progress",
    }).sequence,
    0,
  );
  await assert.rejects(
    f.call(
      "events/subscribe",
      f.params({ name: "audiogram.job.finished", cursor: ahead }),
    ),
  );
  await f.call("events/unsubscribe", {
    name: "audiogram.job.progress",
    arguments: { job_id: f.job.jobId },
    delivery: { mode: "webhook", url: "https://receiver.example.com/callback" },
  });
  f.store.finalizeJob(
    f.job.jobId,
    { status: "failed", artifacts: [] },
    { capture: "unknown" },
  );
  f.advance(31 * 86400000);
  f.store.pruneEventHistory({ now: f.clock() });
  assert.throws(
    () => f.store.finalizeJob(f.job.jobId, { status: "failed", artifacts: [] }),
    /expired/i,
  );
  const late = await f.call("events/subscribe", f.params());
  assert.equal(late.id, first.id);
  assert.equal(late.truncated, true);
  assert.equal(late.currentStatus.status, "failed");
});

test("fast terminal jobs replay finish and legacy materialization records unknown history only after authorization", async (t) => {
  const f = await fixture(t);
  f.store.setResult(f.job.jobId, { status: "no_clips", artifacts: [] });
  await assert.rejects(
    f.call("events/subscribe", f.params({ name: "audiogram.job.finished" }), {
      id: "other-owner",
    }),
  );
  assert.equal(f.store.listJobEvents({ jobId: f.job.jobId }).length, 0);
  const response = await f.call(
    "events/subscribe",
    f.params({ name: "audiogram.job.finished" }),
  );
  const [finish] = f.store.listJobEvents({ jobId: f.job.jobId });
  assert.equal(finish.data.status, "no_clips");
  assert.equal(finish.data.progress_history, "unknown");
  assert.equal(response.currentStatus.status, "no_clips");
});
