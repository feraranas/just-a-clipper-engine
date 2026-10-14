import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openRecoveryStore } from "./publishing-recovery-store.mjs";
import { inspectRecovery } from "./publishing-recovery.mjs";
import {
  recoveryFixture,
  uploadError,
} from "./test-support/recovery-fixture.mjs";

test("read-only store never creates missing databases or migrates old schemas", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "recovery-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "missing.sqlite");
  assert.throws(() => openRecoveryStore(path));
  await assert.rejects(stat(path), { code: "ENOENT" });
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE old(value TEXT)");
  db.close();
  const store = openRecoveryStore(path);
  t.after(() => store.close());
  assert.throws(() => store.readSnapshot("item"), /schema/i);
  const check = new DatabaseSync(path, { readOnly: true });
  assert.deepEqual(
    check
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name),
    ["old"],
  );
  check.close();
});

for (const legacy of [true, false])
  test(`atomic recovery preserves ${legacy ? "legacy" : "failed"} attempt and requires new approval`, async (t) => {
    const f = await recoveryFixture(t);
    if (!legacy)
      f.execution.recordDiagnostic(f.attemptId, {
        ...uploadError,
        operation: "container_status",
      });
    const store = openRecoveryStore(f.path);
    t.after(() => store.close());
    const inspection = await inspectRecovery({ ...f, store });
    const result = store.applyRecovery(inspection);
    assert.equal(result.status, "queued_for_reapproval");
    const item = f.ledger.getPublishingItem(f.itemId);
    assert.equal(item.state, "queued");
    assert.equal(item.caption, "approved");
    assert.equal(item.accountId, "2");
    for (const key of [
      "approvedAt",
      "approvedCaption",
      "approvedArtifactHash",
      "approvalDecision",
      "scheduledAt",
      "containerId",
      "mediaId",
    ])
      assert.equal(item[key], null, key);
    const old = f.execution.getAttempt(f.itemId);
    assert.equal(old.id, f.attemptId);
    assert.equal(old.containerId, "123");
    assert.equal(old.phase, "failed");
    assert.equal(old.safeToRetry, false);
    assert.throws(() => store.applyRecovery(inspection));
    assert.throws(() => f.execution.beginAttempt(f.itemId));
    f.ledger.approveItem(f.itemId, "2026-10-03T00:00:00Z");
    f.ledger.claimDueApprovedItem("2026-10-13T00:00:00Z");
    const replacement = f.execution.beginAttempt(f.itemId);
    assert.notEqual(replacement, f.attemptId);
    assert.throws(() => f.execution.beginAttempt(f.itemId));
    const db = new DatabaseSync(f.path, { readOnly: true });
    const audit = db.prepare("SELECT * FROM publishing_recoveries").get();
    assert.equal(audit.old_attempt_id, f.attemptId);
    assert.equal(audit.replacement_attempt_id, replacement);
    assert.equal(audit.container_id, "123");
    assert.ok(!audit.evidence_json.includes("upload_uri"));
    db.close();
  });
for (const mutation of [
  "caption",
  "artifact_hash",
  "account_id",
  "state",
  "media_id",
  "phase",
  "attempt",
])
  test(`stale ${mutation} prevents apply`, async (t) => {
    const f = await recoveryFixture(t),
      store = openRecoveryStore(f.path);
    t.after(() => store.close());
    const inspection = await inspectRecovery({ ...f, store });
    const db = new DatabaseSync(f.path);
    if (mutation === "phase")
      db.prepare(
        "UPDATE publishing_attempts SET phase='publish_requested'",
      ).run();
    else if (mutation === "attempt")
      db.prepare("UPDATE publishing_attempts SET id='other'").run();
    else
      db.prepare(`UPDATE publishing_items SET ${mutation}=?`).run(
        mutation === "state" ? "unknown" : "changed",
      );
    db.close();
    assert.throws(() => store.applyRecovery(inspection), /Stale/);
  });
test("audit insertion failure rolls back all item, attempt and diagnostic fields", async (t) => {
  const f = await recoveryFixture(t),
    store = openRecoveryStore(f.path);
  t.after(() => store.close());
  const inspection = await inspectRecovery({ ...f, store });
  const db = new DatabaseSync(f.path);
  const before = store.readSnapshot(f.itemId);
  // Schema is owned by execution initialization, not by read-only inspection.
  db.exec(
    "CREATE TRIGGER reject_recovery BEFORE INSERT ON publishing_recoveries BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END",
  );
  const diagnostics = db.prepare("SELECT * FROM publishing_diagnostics").all();
  assert.throws(() => store.applyRecovery(inspection), /injected/);
  assert.deepEqual(store.readSnapshot(f.itemId), before);
  assert.deepEqual(
    db.prepare("SELECT * FROM publishing_diagnostics").all(),
    diagnostics,
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM publishing_recoveries").get().n,
    0,
  );
  db.close();
});
test("recovering a confirmed upload rejection revokes generic retry but retains its original error", async (t) => {
  const f = await recoveryFixture(t);
  f.execution.checkpoint(f.attemptId, "failed", {
    errorCode: "UPLOAD_REJECTED",
    safeToRetry: true,
  });
  const store = openRecoveryStore(f.path);
  t.after(() => store.close());
  store.applyRecovery(await inspectRecovery({ ...f, store }));
  assert.equal(f.execution.getAttempt(f.itemId).safeToRetry, false);
  assert.equal(f.execution.getAttempt(f.itemId).errorCode, "UPLOAD_REJECTED");
});
