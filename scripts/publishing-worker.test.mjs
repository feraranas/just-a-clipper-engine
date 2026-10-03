import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createPublishingLedger } from "./publishing-ledger.mjs";
import { createPublishingExecution, acquireWorkerLock } from "./publishing-execution.mjs";
import { runPublishingOnce } from "./publishing-worker.mjs";

const now = () => "2026-10-03T12:00:00.000Z";
const config = { accountId: "2", pageId: "1", username: "theballooninquiries" };
const fixture = async (t, changes = {}) => {
  const root = await mkdtemp(join(tmpdir(), "publishing-worker-"));
  const bytes = Buffer.from("approved bytes");
  await writeFile(join(root, "clip.mp4"), bytes);
  const path = join(root, "queue.sqlite");
  const ledger = createPublishingLedger(path);
  const execution = createPublishingExecution(path);
  const lock = await acquireWorkerLock(path);
  t.after(async () => { await lock.release(); execution.close(); ledger.close(); await rm(root, { recursive: true, force: true }); });
  const item = ledger.enqueueArtifact({ artifactRelativePath: "clip.mp4", artifactHash: "sha256:" + createHash("sha256").update(bytes).digest("hex"), title: "clip", caption: "approved", accountId: "2", ...changes });
  ledger.approveItem(item.id, "2026-10-03T11:00:00Z");
  const calls = [];
  const client = {
    verifyAccount: async (identity) => { assert.equal(identity.accountId, "2"); calls.push("verifyAccount"); },
    createContainer: async (input) => { calls.push("createContainer"); assert.equal(input.caption, "approved"); assert.equal(execution.getAttempt(item.id).phase, "create_requested"); return { id: "123", uri: "https://rupload.facebook.com/ig-api-upload/v26.0/123" }; },
    uploadVideo: async ({fileHandle, size}) => { calls.push("uploadVideo"); assert.equal(execution.getAttempt(item.id).phase, "upload_requested"); assert.equal(size, bytes.length); const buffer = Buffer.alloc(size); await fileHandle.read(buffer, 0, size, 0); assert.deepEqual(buffer, bytes); },
    getContainerStatus: async () => { calls.push("getContainerStatus"); return { statusCode: "FINISHED" }; },
    publishContainer: async ({containerId}) => { calls.push("publishContainer"); assert.equal(containerId, "123"); assert.equal(execution.getAttempt(item.id).phase, "publish_requested"); return { id: "456" }; },
  };
  const args = { ledger, execution, lock, client, config: { ...config, projectRoot: root }, itemId: item.id, now, sleep: async () => {} };
  return { ...args, args, calls, root, id: item.id };
};

test("one approved item publishes in order and another invocation does not publish again", async (t) => {
  const f = await fixture(t);
  assert.equal((await runPublishingOnce(f.args)).status, "published");
  assert.deepEqual(f.calls, ["verifyAccount", "createContainer", "uploadVideo", "getContainerStatus", "publishContainer"]);
  assert.equal(f.ledger.getPublishingItem(f.id).mediaId, "456");
  await runPublishingOnce(f.args);
  assert.equal(f.calls.filter((c) => c === "publishContainer").length, 1);
});

for (const reason of ["account", "caption", "future", "rejected", "hash", "missing", "symlink"]) {
  test(`no external writes for ${reason}`, async (t) => {
    const f = await fixture(t, reason === "account" ? { accountId: "3" } : {});
    if (reason === "caption") f.ledger.updateCaption(f.id, "new");
    if (reason === "future") { f.ledger.updateCaption(f.id, "new"); f.ledger.approveItem(f.id, "2099-01-01T00:00:00Z"); }
    if (reason === "rejected") f.ledger.rejectItem(f.id, "No");
    if (reason === "hash") await writeFile(join(f.root, "clip.mp4"), "tampered");
    if (["missing", "symlink"].includes(reason)) await rm(join(f.root, "clip.mp4"));
    if (reason === "symlink") await symlink("/etc/hosts", join(f.root, "clip.mp4"));
    await runPublishingOnce(f.args);
    assert.deepEqual(f.calls.filter((c) => c !== "verifyAccount"), []);
  });
}

test("account preflight failure leaves the approval unclaimed", async (t) => {
  const f = await fixture(t);
  f.client.verifyAccount = async () => { throw new Error("expired"); };
  await assert.rejects(runPublishingOnce(f.args));
  assert.equal(f.ledger.getPublishingItem(f.id).state, "approved");
});

for (const phase of ["claimed", "create_requested", "container_created", "upload_requested", "processing", "publish_requested", "published"]) {
  test(`crash at ${phase} resumes conservatively without duplicate publication`, async (t) => {
    const f = await fixture(t);
    const interrupted = { ...f.execution,
      beginAttempt: (id) => { const result = f.execution.beginAttempt(id); if (phase === "claimed") throw new Error("crash"); return result; },
      checkpoint: (...args) => { const result = f.execution.checkpoint(...args); if (args[1] === phase) throw new Error("crash"); return result; },
    };
    await assert.rejects(runPublishingOnce({ ...f.args, execution: interrupted }), /crash/);
    await runPublishingOnce(f.args);
    await runPublishingOnce(f.args);
    assert.ok(f.calls.filter((c) => c === "createContainer").length <= 1);
    assert.ok(f.calls.filter((c) => c === "uploadVideo").length <= 1);
    assert.ok(f.calls.filter((c) => c === "publishContainer").length <= 1);
    if (["create_requested", "publish_requested"].includes(phase)) assert.equal(f.ledger.getPublishingItem(f.id).state, "unknown");
    else assert.equal(f.ledger.getPublishingItem(f.id).state, "published");
  });
}

test("processing exhaustion stays pending, resumes by reading without resending bytes", async (t) => {
  const f = await fixture(t); const waits = []; let reads = 0;
  f.client.getContainerStatus = async () => { reads++; return { statusCode: "IN_PROGRESS" }; };
  assert.equal((await runPublishingOnce({ ...f.args, sleep: async (ms) => waits.push(ms) })).status, "pending");
  assert.equal(reads, 5); assert.deepEqual(waits, [60000,60000,60000,60000]);
  assert.equal(f.ledger.getPublishingItem(f.id).state, "processing");
  f.client.getContainerStatus = async () => ({ statusCode: "FINISHED" });
  await runPublishingOnce(f.args);
  assert.equal(f.calls.filter((c) => c === "uploadVideo").length, 1);
});

test("lost publish response becomes unknown and is never retried", async (t) => {
  const f = await fixture(t); let writes = 0;
  f.client.publishContainer = async () => { writes++; throw new Error("connection lost"); };
  assert.equal((await runPublishingOnce(f.args)).status, "unknown");
  await runPublishingOnce(f.args);
  assert.equal(writes, 1);
});

for (const statusCode of ["ERROR", "EXPIRED", "PUBLISHED"]) {
  test(`container ${statusCode} cannot trigger publication`, async (t) => {
    const f = await fixture(t);
    f.client.getContainerStatus = async () => ({ statusCode });
    await runPublishingOnce(f.args);
    assert.equal(f.ledger.getPublishingItem(f.id).state, statusCode === "PUBLISHED" ? "unknown" : "failed");
    assert.equal(f.calls.includes("publishContainer"), false);
  });
}

test("file mutation during upload is caught before publication", async (t) => {
  const f = await fixture(t);
  f.client.uploadVideo = async () => { await writeFile(join(f.root, "clip.mp4"), "changed during upload"); };
  await runPublishingOnce(f.args);
  assert.equal(f.ledger.getPublishingItem(f.id).state, "failed");
  assert.equal(f.calls.includes("publishContainer"), false);
});

test("ownership loss prevents the next external write", async (t) => {
  const f = await fixture(t); let checks = 0;
  const lock = { assertOwned: async () => { if (++checks > 1) throw new Error("ownership lost"); } };
  await assert.rejects(runPublishingOnce({ ...f.args, lock }), /ownership/);
  assert.equal(f.calls.includes("createContainer"), false);
});

for (const phase of ["container_created", "processing", "published"]) {
  test(`lost local commit after ${phase} response cannot duplicate an external write`, async (t) => {
    const f = await fixture(t);
    const execution = { ...f.execution, checkpoint: (...args) => {
      if (args[1] === phase) throw new Error("disk failure");
      return f.execution.checkpoint(...args);
    } };
    await assert.rejects(runPublishingOnce({ ...f.args, execution }), (error) => {
      assert.match(error.message, /disk failure/);
      if (phase === "published") assert.equal(error.confirmedMediaId, "456");
      return true;
    });
    await runPublishingOnce(f.args);
    assert.equal(f.calls.filter((c) => c === "createContainer").length, 1);
    assert.ok(f.calls.filter((c) => c === "uploadVideo").length <= 1);
    assert.ok(f.calls.filter((c) => c === "publishContainer").length <= 1);
  });
}
