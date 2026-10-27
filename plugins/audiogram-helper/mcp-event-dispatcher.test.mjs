import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createJobStore } from "./job-store.mjs";
import { createEventMethods } from "./mcp-events.mjs";
import { createEventSecrets } from "./mcp-event-secrets.mjs";
import { createWebhookClient } from "./mcp-webhook.mjs";
import { projectStageFact } from "./mcp-event-contract.mjs";
import {
  validateCliResult,
  validateStoredResult,
} from "./result-validation.mjs";
import {
  dispatcherTick,
  startEventDispatcher,
} from "./mcp-event-dispatcher.mjs";

const principal = { id: "local-owner" };
const secret = `whsec_${Buffer.alloc(32, 4).toString("base64")}`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mcp-dispatcher-"));
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
  const validateResult = (result) => validateStoredResult(result, root);
  const methods = createEventMethods({
    store,
    secrets,
    webhook: { verifyCallback: async () => ({ verified: true }) },
    clock: () => now,
    validateResult,
  });
  const params = (name = "audiogram.job.progress", path = "callback") => ({
    name,
    arguments: { job_id: job.jobId },
    delivery: {
      mode: "webhook",
      url: `https://receiver.example.com/${path}`,
      secret,
    },
    cursor: null,
  });
  const subscribe = (name, path) =>
    methods.handleEventRequest({
      principal,
      method: "events/subscribe",
      params: params(name, path),
    });
  const cancel = (name = "audiogram.job.progress", path = "callback") => {
    const input = params(name, path);
    delete input.delivery.secret;
    delete input.cursor;
    return methods.handleEventRequest({
      principal,
      method: "events/unsubscribe",
      params: input,
    });
  };
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
  const complete = async () => {
    await mkdir(join(root, "out", "treatments"), { recursive: true });
    await writeFile(
      join(root, "out", "treatments", "video.mp4"),
      "fixture-video",
    );
    const result = await validateCliResult(
      {
        contractVersion: 1,
        status: "complete",
        artifactPaths: ["out/treatments/video.mp4"],
      },
      root,
      { recordArtifactHashes: true },
    );
    return store.finalizeJob(job.jobId, result, { capture: "complete" });
  };
  const tick = (webhook) =>
    dispatcherTick({
      store,
      webhook,
      secrets,
      clock: () => now,
      random: () => 0,
      validateResult,
    });
  return {
    root,
    file,
    store,
    job,
    secrets,
    subscribe,
    cancel,
    append,
    complete,
    tick,
    clock: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("blocked progress delivery does not block finish or change a verified successful result", async (t) => {
  const f = await fixture(t);
  await f.subscribe();
  await f.subscribe("audiogram.job.finished");
  f.append();
  f.append();
  await f.complete();
  const received = [];
  const client = createWebhookClient({
    clock: f.clock,
    transport: async (input) => {
      const body = JSON.parse(input.body);
      received.push(body);
      return {
        status: body.name === "audiogram.job.progress" ? 503 : 200,
        headers: {},
        body: "{}",
      };
    },
  });
  const first = await f.tick(client);
  assert.equal(first.claimed, 2);
  assert.equal(first.acknowledged, 1);
  assert.equal(first.failed, 1);
  assert.equal(f.store.getJob(f.job.jobId).status, "complete");
  assert.equal(
    f.store.getNotificationHealth(f.job.jobId, { principal, now: f.clock() })
      .delivery,
    "degraded",
  );
  assert.deepEqual(
    received
      .filter((event) => event.name === "audiogram.job.progress")
      .map((event) => event.data.sequence),
    [1],
  );
  assert.equal((await f.tick(client)).claimed, 0);
});

test("retry keeps event identity and body but refreshes the signing timestamp and signature", async (t) => {
  const f = await fixture(t);
  await f.subscribe();
  f.append();
  const requests = [];
  const client = createWebhookClient({
    clock: f.clock,
    transport: async (input) => {
      requests.push(input);
      return {
        status: requests.length === 1 ? 503 : 200,
        headers: {},
        body: "{}",
      };
    },
  });
  await f.tick(client);
  f.advance(5000);
  await f.tick(client);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(
    requests[0].headers["webhook-id"],
    requests[1].headers["webhook-id"],
  );
  assert.notEqual(
    requests[0].headers["webhook-signature"],
    requests[1].headers["webhook-signature"],
  );
});

test("two connections cannot claim one delivery and expired claim tokens cannot acknowledge a new lease", async (t) => {
  const f = await fixture(t);
  await f.subscribe();
  f.append();
  const other = createJobStore(f.file);
  t.after(() => other.close());
  const [first] = f.store.claimDueDeliveries({
    now: f.clock(),
    limit: 20,
    leaseMs: 60000,
  });
  assert.equal(
    other.claimDueDeliveries({ now: f.clock(), limit: 20, leaseMs: 60000 })
      .length,
    0,
  );
  f.advance(60001);
  const [second] = other.claimDueDeliveries({
    now: f.clock(),
    limit: 20,
    leaseMs: 60000,
  });
  assert.equal(second.id, first.id);
  assert.notEqual(second.claimToken, first.claimToken);
  assert.equal(
    f.store.acknowledgeDelivery({
      id: first.id,
      claimToken: first.claimToken,
      now: f.clock(),
    }),
    false,
  );
  assert.equal(
    other.acknowledgeDelivery({
      id: second.id,
      claimToken: second.claimToken,
      now: f.clock(),
    }),
    true,
  );
});

test("cancellation before or during a send stops future work and invalidates its acknowledgment", async (t) => {
  const f = await fixture(t);
  await f.subscribe();
  f.append();
  const client = createWebhookClient({
    clock: f.clock,
    transport: async () => {
      await f.cancel();
      return { status: 200, headers: {}, body: "{}" };
    },
  });
  const result = await f.tick(client);
  assert.equal(result.sent, 1);
  assert.equal(result.acknowledged, 0);
  assert.equal((await f.tick(client)).claimed, 0);
  assert.equal(
    f.store.getNotificationHealth(f.job.jobId, { principal, now: f.clock() })
      .delivery,
    "stopped",
  );
});

test("permanent response classes stop delivery; transient failures stop after eight bounded attempts", async (t) => {
  for (const status of [
    302, 400, 401, 403, 404, 410, 413, 408, 429, 500, 503,
  ]) {
    await t.test(String(status), async (t) => {
      const f = await fixture(t);
      await f.subscribe();
      f.append();
      let calls = 0;
      const client = createWebhookClient({
        clock: f.clock,
        transport: async () => {
          calls++;
          return { status, headers: {}, body: "{}" };
        },
      });
      for (let attempt = 0; attempt < 10; attempt++) {
        await f.tick(client);
        f.advance(400000);
      }
      assert.equal(calls, [408, 429, 500, 503].includes(status) ? 8 : 1);
      assert.equal(
        f.store.getNotificationHealth(f.job.jobId, {
          principal,
          now: f.clock(),
        }).delivery,
        "stopped",
      );
    });
  }
});

test("Retry-After is honored without skipping the first pending event", async (t) => {
  const f = await fixture(t);
  await f.subscribe();
  f.append();
  f.append();
  let calls = 0;
  const client = createWebhookClient({
    clock: f.clock,
    transport: async () => {
      calls++;
      return { status: 429, headers: { "retry-after": "120" }, body: "{}" };
    },
  });
  await f.tick(client);
  f.advance(119999);
  await f.tick(client);
  assert.equal(calls, 1);
  f.advance(1);
  await f.tick(client);
  assert.equal(calls, 2);
});

test("dispatcher limits concurrency to four across subscriptions", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++)
    await f.subscribe("audiogram.job.progress", `callback-${i}`);
  f.append();
  let active = 0;
  let maximum = 0;
  const client = createWebhookClient({
    clock: f.clock,
    transport: async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return { status: 200, headers: {}, body: "{}" };
    },
  });
  assert.equal((await f.tick(client)).acknowledged, 10);
  assert.equal(maximum, 4);
});

test("an individual callback timeout leaves retry work without failing processing", async (t) => {
  const f = await fixture(t);
  await f.subscribe();
  f.append();
  const client = createWebhookClient({
    timeoutMs: 5,
    clock: f.clock,
    transport: () => new Promise(() => {}),
  });
  const result = await f.tick(client);
  assert.equal(result.failed, 1);
  assert.equal(f.store.getJob(f.job.jobId).status, "queued");
});

test("service-owned loop backs off on database failure and stops with an abortable wait", async () => {
  const waits = [];
  let loop;
  loop = startEventDispatcher({
    store: {
      reconcileDeliveries() {
        throw new Error("private database detail");
      },
    },
    sleep: async (ms, signal) => {
      waits.push(ms);
      queueMicrotask(() => loop.stop());
      await new Promise((resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  await loop.done;
  assert.deepEqual(waits, [1000]);
});

test("retry scheduling clamps jitter and Retry-After and stores only safe diagnostic codes", async (t) => {
  for (const [random, retryAfter, delay] of [[() => 1, "invalid", 6000], [() => -1, undefined, 5000],
    [() => 2, undefined, 6000], [() => 0, "999999", 300000],
    [() => 0, "Mon, 26 Oct 2026 12:01:00 GMT", 60000]]) {
    const f = await fixture(t); await f.subscribe(); f.append();
    const [claim] = f.store.claimDueDeliveries({ now: f.clock() });
    f.store.failDelivery({ ...claim, now: f.clock(), httpStatus: 503, retryAfter, random, code: "private-url-detail" });
    const raw = new DatabaseSync(f.file);
    const row = raw.prepare("SELECT next_attempt_at,last_code FROM event_deliveries WHERE id=?").get(claim.id);
    raw.close();
    assert.equal(row.next_attempt_at, f.clock() + delay);
    assert.equal(row.last_code, "delivery_failed");
  }
});
