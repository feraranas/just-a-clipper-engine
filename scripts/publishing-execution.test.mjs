import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createPublishingLedger } from "./publishing-ledger.mjs";
import { createPublishingExecution, acquireWorkerLock } from "./publishing-execution.mjs";

const setup = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "publishing-execution-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "queue.sqlite");
  const ledger = createPublishingLedger(path);
  t.after(() => ledger.close());
  const item = ledger.enqueueArtifact({ artifactRelativePath: "clip.mp4", artifactHash: "hash", title: "clip", caption: "", accountId: "1" });
  ledger.approveItem(item.id, "2026-01-01T00:00:00Z");
  ledger.claimDueApprovedItem("2026-01-02T00:00:00Z");
  return { path, ledger, id: item.id };
};

test("checkpoints survive reopen, reject regressions and secret-bearing fields, and atomically publish", async (t) => {
  const { path, ledger, id } = await setup(t);
  let execution = createPublishingExecution(path);
  const attempt = execution.beginAttempt(id);
  execution.checkpoint(attempt, "create_requested");
  execution.close();
  execution = createPublishingExecution(path);
  t.after(() => execution.close());
  assert.equal(execution.getAttempt(id).phase, "create_requested");
  assert.throws(() => execution.checkpoint(attempt, "claimed"), /phase/);
  assert.throws(() => execution.checkpoint(attempt, "container_created", { token: "secret" }), /patch/);
  execution.checkpoint(attempt, "container_created", { containerId: "123", uploadUri: "https://rupload.facebook.com/ig-api-upload/v26.0/123" });
  assert.equal(ledger.getPublishingItem(id).containerId, "123");
  execution.checkpoint(attempt, "upload_requested");
  execution.checkpoint(attempt, "processing");
  execution.checkpoint(attempt, "publish_requested");
  assert.throws(() => execution.checkpoint(attempt, "published"), /mediaId/);
  const db = new DatabaseSync(path);
  db.exec("CREATE TRIGGER block_publish BEFORE UPDATE ON publishing_items WHEN NEW.state = 'published' BEGIN SELECT RAISE(ABORT, 'injected commit failure'); END");
  assert.throws(() => execution.checkpoint(attempt, "published", { mediaId: "456" }), /injected/);
  assert.equal(execution.getAttempt(id).phase, "publish_requested");
  db.exec("DROP TRIGGER block_publish");
  db.close();
  execution.checkpoint(attempt, "published", { mediaId: "456" });
  assert.equal(ledger.getPublishingItem(id).state, "published");
  assert.equal(ledger.getPublishingItem(id).mediaId, "456");
  assert.throws(() => execution.beginAttempt(id), /state|active/);
});

test("safe retry retains old attempt and starts a new ordered attempt only after reapproval", async (t) => {
  const { path, ledger, id } = await setup(t);
  const execution = createPublishingExecution(path);
  t.after(() => execution.close());
  const old = execution.beginAttempt(id);
  execution.checkpoint(old, "failed", { errorCode: "INVALID_ARTIFACT", safeToRetry: true });
  ledger.retryFailedItem(id);
  assert.throws(() => execution.beginAttempt(id), /state/);
  ledger.approveItem(id, "2026-01-01T00:00:00Z");
  ledger.claimDueApprovedItem("2026-01-02T00:00:00Z");
  const current = execution.beginAttempt(id);
  assert.notEqual(current, old);
  assert.equal(execution.getAttempt(id).id, current);
  const db = new DatabaseSync(path);
  assert.equal(db.prepare("SELECT count(*) AS n FROM publishing_attempts").get().n, 2);
  db.close();
});

test("lock excludes another owner and ownership loss cannot delete the replacement", async (t) => {
  const { path } = await setup(t);
  const first = await acquireWorkerLock(path);
  await assert.rejects(acquireWorkerLock(path), /busy/);
  await first.assertOwned();
  await first.release();
  const second = await acquireWorkerLock(path);
  const ownerPath = `${path}.worker-lock/owner.json`;
  const owner = JSON.parse(await readFile(ownerPath, "utf8"));
  await writeFile(ownerPath, JSON.stringify({ ...owner, ownerId: "replacement" }));
  await assert.rejects(second.assertOwned(), /ownership/);
  await assert.rejects(second.release(), /ownership/);
  assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).ownerId, "replacement");
});

test("interrupted process leaves an inspectable lock which is never stolen", async (t) => {
  const { path } = await setup(t);
  const moduleUrl = new URL("./publishing-execution.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {acquireWorkerLock} from ${JSON.stringify(moduleUrl)}; await acquireWorkerLock(${JSON.stringify(path)}); console.log('locked'); setInterval(()=>{},1000);`], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await once(child, "exit");
  assert.equal(JSON.parse(await readFile(`${path}.worker-lock/owner.json`, "utf8")).pid, child.pid);
  await assert.rejects(acquireWorkerLock(path), /busy/);
});
