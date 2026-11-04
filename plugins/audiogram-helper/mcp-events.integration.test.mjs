import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as wait } from "node:timers/promises";
import { startMcpServer } from "./server.mjs";
import { createLocalRunner } from "./local-runner.mjs";
import { createJobStore } from "./job-store.mjs";
import { createWebhookClient } from "./mcp-webhook.mjs";
import { projectStageFact } from "./mcp-event-contract.mjs";
import { validateMcpRuntimeConfig } from "./runtime-config.mjs";
import { persistFinalResult } from "./mcp-finalization.mjs";

const key = Buffer.alloc(32, 1).toString("base64");
const secret = `whsec_${Buffer.alloc(32, 4).toString("base64")}`;
const environment = {
  AUDIOGRAM_LLM_PROVIDER: "chatgpt-oauth",
  AUDIOGRAM_MCP_EVENTS_ENABLED: "1",
  AUDIOGRAM_MCP_EVENTS_MODE: "private-tunnel",
  AUDIOGRAM_EVENT_SECRET_KEY: key,
};
const params = (extra) => ({
  ...extra,
  _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": {
      name: "event-integration",
      version: "1",
    },
    "io.modelcontextprotocol/clientCapabilities": {},
  },
});
async function rpc(url, method, input = {}, owner) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(method === "tools/call" ? { "Mcp-Name": input.name } : {}),
      ...(owner ? { "test-owner": owner } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: params(input),
    }),
  });
  const text = await response.text();
  const body = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .at(-1)
        ?.slice(6)
    : text;
  return JSON.parse(body);
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "mcp-events-wire-"));
  const file = join(root, "jobs.sqlite");
  const store = createJobStore(file, { ownerId: "local-owner" });
  const received = [];
  const workerEnvironments = [];
  const webhookClient = createWebhookClient({
    transport: async (input) => {
      const body = JSON.parse(input.body);
      received.push(input);
      return {
        status: 200,
        headers: {},
        body: JSON.stringify(
          body.type === "verification" ? { challenge: body.challenge } : {},
        ),
      };
    },
  });
  const server = await startMcpServer({
    projectRoot: root,
    port: 0,
    runner: createLocalRunner({
      jobStore: store,
      projectRoot: root,
      eventsEnabled: true,
      diagnosticsRoot: join(root, "runs"),
      environment: { AUDIOGRAM_EVENT_SECRET_KEY: key },
      spawnProcess: (_command, _args, input) => {
        workerEnvironments.push(input.env);
        return { pid: 12345, once() {}, unref() {} };
      },
      isProcessAlive: () => true,
    }),
    webhookClient,
    spawnProcess: () => ({ pid: 12345, once() {}, unref() {} }),
    isProcessAlive: () => true,
    ...options,
    environment: {
      ...environment,
      ...options.environment,
      AUDIOGRAM_JOB_STORE: file,
      AUDIOGRAM_DIAGNOSTICS_ROOT: join(root, "runs"),
    },
  });
  t.after(async () => {
    await server.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    file,
    store,
    received,
    server,
    workerEnvironments,
    webhookClient,
  };
}

test("Events startup rejects missing protection keys and shared mode without trusted identity", () => {
  assert.throws(
    () =>
      validateMcpRuntimeConfig({
        ...environment,
        AUDIOGRAM_EVENT_SECRET_KEY: "",
      }),
    /protection key/,
  );
  assert.throws(
    () =>
      validateMcpRuntimeConfig({
        ...environment,
        AUDIOGRAM_MCP_EVENTS_MODE: "shared",
      }),
    /principal resolver/,
  );
  assert.equal(
    validateMcpRuntimeConfig({ AUDIOGRAM_LLM_PROVIDER: "chatgpt-oauth" })
      .eventsEnabled,
    false,
  );
});

test("modern wire discovers Events, verifies a subscription and delivers real durable facts without restarting per request", async (t) => {
  const f = await fixture(t);
  const created = await rpc(f.server.url, "tools/call", {
    name: "create_audiogram",
    arguments: { url: "https://youtu.be/abcdefghijk" },
  });
  const jobId = created.result.structuredContent.jobId;
  assert.equal(f.store.getJob(jobId).ownerId, "local-owner");
  assert.equal(f.workerEnvironments[0].AUDIOGRAM_EVENT_SECRET_KEY, undefined);
  assert.equal(f.workerEnvironments[0].AUDIOGRAM_EVENT_CAPTURE_ENABLED, "1");
  const discovery = await rpc(f.server.url, "server/discover");
  assert.deepEqual(discovery.result.capabilities.events, {});
  const catalog = await rpc(f.server.url, "events/list");
  assert.equal(catalog.result.events.length, 2);
  const subscribed = await rpc(f.server.url, "events/subscribe", {
    name: "audiogram.job.progress",
    arguments: { job_id: jobId },
    delivery: {
      mode: "webhook",
      url: "https://receiver.example.com/callback?private=value",
      secret,
    },
    cursor: null,
  });
  assert.match(subscribed.result.id, /^sub_/);
  const job = f.store.getJob(jobId);
  const sourceId = randomUUID();
  f.store.appendProgress({
    jobId,
    sourceId,
    fact: projectStageFact({
      job,
      sourceId,
      stageInstanceId: randomUUID(),
      normalized: { stage: "transcript", status: "completed" },
    }),
  });
  const deadline = Date.now() + 2500;
  while (
    !f.received.some(
      (entry) => JSON.parse(entry.body).name === "audiogram.job.progress",
    ) &&
    Date.now() < deadline
  )
    await wait(10);
  assert.equal(
    f.received.filter(
      (entry) => JSON.parse(entry.body).name === "audiogram.job.progress",
    ).length,
    1,
  );
  const status = await rpc(f.server.url, "tools/call", {
    name: "get_audiogram_status",
    arguments: { jobId },
  });
  assert.equal(
    status.result.structuredContent.notificationHealth.delivery,
    "active",
  );
  assert.equal(
    status.result.structuredContent.notificationHealth.subscriptions[0].id,
    subscribed.result.id,
  );
  assert.equal(JSON.stringify(status).includes(secret), false);
  assert.equal(JSON.stringify(status).includes("private=value"), false);
  const templates = await rpc(f.server.url, "tools/call", {
    name: "list_video_templates",
    arguments: {},
  });
  assert.equal(templates.result.isError, undefined);
});

test("shared tools and subscriptions cannot reveal, deduplicate or retry another owner's job", async (t) => {
  const f = await fixture(t, {
    environment: { ...environment, AUDIOGRAM_MCP_EVENTS_MODE: "shared" },
    principalResolver: async (req) =>
      req.headers["test-owner"] ? { id: req.headers["test-owner"] } : null,
  });
  const created = await rpc(
    f.server.url,
    "tools/call",
    {
      name: "create_audiogram",
      arguments: { url: "https://youtu.be/abcdefghijk" },
    },
    "owner-a",
  );
  const jobId = created.result.structuredContent.jobId;
  const other = await rpc(
    f.server.url,
    "tools/call",
    { name: "get_audiogram_status", arguments: { jobId } },
    "owner-b",
  );
  assert.equal(other.result.isError, true);
  const busy = await rpc(
    f.server.url,
    "tools/call",
    {
      name: "create_audiogram",
      arguments: { url: "https://youtu.be/abcdefghijk" },
    },
    "owner-b",
  );
  assert.equal(busy.result.isError, true);
  assert.equal(JSON.stringify(busy).includes(jobId), false);
  const retry = await rpc(
    f.server.url,
    "tools/call",
    { name: "retry_audiogram", arguments: { jobId } },
    "owner-b",
  );
  assert.equal(retry.result.isError, true);
  const subscription = await rpc(
    f.server.url,
    "events/subscribe",
    {
      name: "audiogram.job.progress",
      arguments: { job_id: jobId },
      delivery: {
        mode: "webhook",
        url: "https://receiver.example.com",
        secret,
      },
    },
    "owner-b",
  );
  assert.equal(subscription.error.code, -32001);
});

test("private ownership migration is explicit and shared startup rejects ownerless legacy jobs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mcp-legacy-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "jobs.sqlite");
  const store = createJobStore(file);
  const job = store.createOrGetJob({
    videoId: "legacy",
    sourceUrl: "https://youtu.be/abcdefghijk",
  }).job;
  const runner = { getStatus() {} };
  try {
    await assert.rejects(
      startMcpServer({
        projectRoot: root,
        port: 0,
        runner,
        principalResolver: async () => ({ id: "owner-a" }),
        environment: {
          ...environment,
          AUDIOGRAM_JOB_STORE: file,
          AUDIOGRAM_MCP_EVENTS_MODE: "shared",
        },
      }),
      /owner migration/,
    );
    const server = await startMcpServer({
      projectRoot: root,
      port: 0,
      runner,
      environment: { ...environment, AUDIOGRAM_JOB_STORE: file },
    });
    try {
      assert.equal(store.getJob(job.jobId).ownerId, "local-owner");
    } finally {
      await server.close();
    }
  } finally {
    store.close();
  }
});

test("restart resumes persisted deliveries and safe subscription lookup enforces ownership", async (t) => {
  const f = await fixture(t);
  const created = await rpc(f.server.url, "tools/call", {
    name: "create_audiogram",
    arguments: { url: "https://youtu.be/abcdefghijk" },
  });
  const jobId = created.result.structuredContent.jobId;
  const subscribed = await rpc(f.server.url, "events/subscribe", {
    name: "audiogram.job.progress",
    arguments: { job_id: jobId },
    delivery: { mode: "webhook", url: "https://receiver.example.com", secret },
  });
  await f.server.close();
  const job = f.store.getJob(jobId),
    sourceId = randomUUID();
  f.store.appendProgress({
    jobId,
    sourceId,
    fact: projectStageFact({
      job,
      sourceId,
      stageInstanceId: randomUUID(),
      normalized: { stage: "jev", status: "started" },
    }),
  });
  const restarted = await startMcpServer({
    projectRoot: f.root,
    port: 0,
    runner: {},
    webhookClient: f.webhookClient,
    environment: { ...environment, AUDIOGRAM_JOB_STORE: f.file },
  });
  try {
    const deadline = Date.now() + 2500;
    while (
      !f.received.some(
        (entry) => JSON.parse(entry.body).name === "audiogram.job.progress",
      ) &&
      Date.now() < deadline
    )
      await wait(10);
    assert.equal(
      f.received.filter(
        (entry) => JSON.parse(entry.body).name === "audiogram.job.progress",
      ).length,
      1,
    );
    const health = f.store.getNotificationHealth(jobId, {
      principal: { id: "local-owner" },
      subscriptionId: subscribed.result.id,
    });
    assert.equal(health.subscriptions[0].id, subscribed.result.id);
    assert.throws(() =>
      f.store.getNotificationHealth(jobId, {
        principal: { id: "wrong-owner" },
        subscriptionId: subscribed.result.id,
      }),
    );
    const raw = new DatabaseSync(f.file);
    try {
      raw
        .prepare("UPDATE jobs SET owner_id='changed-owner' WHERE job_id=?")
        .run(jobId);
    } finally {
      raw.close();
    }
    assert.throws(() =>
      f.store.getNotificationHealth(jobId, {
        principal: { id: "local-owner" },
      }),
    );
  } finally {
    await restarted.close();
  }
});

test("startup recovers a pending final result before a stopped worker can be classified as failed", async (t) => {
  const f = await fixture(t);
  await f.server.close();
  const job = f.store.createOrGetJob({
    videoId: "recover",
    sourceUrl: "https://youtu.be/abcdefghijk",
  }).job;
  f.store.markRunning(job.jobId, 12345);
  const raw = new DatabaseSync(f.file);
  try {
    raw.exec(
      "CREATE TRIGGER fail_finish BEFORE INSERT ON event_outbox BEGIN SELECT RAISE(ABORT,'outage'); END",
    );
    const pending = await persistFinalResult({
      store: f.store,
      jobId: job.jobId,
      recoveryRoot: join(f.root, "runs"),
      sleep: async () => {},
      result: { status: "no_clips", artifacts: [], title: null },
      capture: "complete",
    });
    assert.equal(pending.finalized, false);
    raw.exec("DROP TRIGGER fail_finish");
  } finally {
    raw.close();
  }
  const restarted = await startMcpServer({
    projectRoot: f.root,
    port: 0,
    webhookClient: f.webhookClient,
    environment: {
      ...environment,
      AUDIOGRAM_JOB_STORE: f.file,
      AUDIOGRAM_DIAGNOSTICS_ROOT: join(f.root, "runs"),
    },
    isProcessAlive: () => false,
  });
  try {
    assert.equal(f.store.getJob(job.jobId).status, "no_clips");
    const status = await rpc(restarted.url, "tools/call", {
      name: "get_audiogram_status",
      arguments: { jobId: job.jobId },
    });
    assert.equal(status.result.structuredContent.status, "no_clips");
    assert.equal(f.store.listJobEvents({ jobId: job.jobId }).length, 1);
  } finally {
    await restarted.close();
  }
});

test("notification health failures do not replace a terminal processing result", async (t) => {
  const f = await fixture(t);
  const created = await rpc(f.server.url, "tools/call", {
    name: "create_audiogram",
    arguments: { url: "https://youtu.be/abcdefghijk" },
  });
  const jobId = created.result.structuredContent.jobId;
  f.store.finalizeJob(
    jobId,
    { status: "no_clips", artifacts: [], title: null },
    { capture: "complete" },
  );
  f.store.getNotificationHealth = () => {
    throw new Error("diagnostic database outage");
  };
  const status = await rpc(f.server.url, "tools/call", {
    name: "get_audiogram_status",
    arguments: { jobId },
  });
  assert.equal(status.result.structuredContent.status, "no_clips");
  assert.equal(
    status.result.structuredContent.notificationHealth.delivery,
    "degraded",
  );
  assert.equal(f.store.getJob(jobId).status, "no_clips");
});

test("shutdown aborts an in-flight subscription challenge before closing the store", async (t) => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await fixture(t, {
    webhookClient: {
      verifyCallback: ({ signal }) =>
        new Promise((_resolve, reject) => {
          entered();
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    },
  });
  const created = await rpc(f.server.url, "tools/call", {
    name: "create_audiogram",
    arguments: { url: "https://youtu.be/abcdefghijk" },
  });
  const pending = rpc(f.server.url, "events/subscribe", {
    name: "audiogram.job.progress",
    arguments: { job_id: created.result.structuredContent.jobId },
    delivery: { mode: "webhook", url: "https://receiver.example.com", secret },
  });
  await started;
  await f.server.close();
  assert.equal((await pending).error.code, -32015);
});
