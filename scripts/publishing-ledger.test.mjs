import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createPublishingLedger } from "./publishing-ledger.mjs";

const createTestLedger = async (t, now = "2026-09-20T12:00:00.000Z") => {
  const directory = await mkdtemp(join(tmpdir(), "publishing-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = createPublishingLedger(join(directory, "publishing.sqlite"), {
    now: () => now,
  });
  t.after(() => ledger.close());
  return ledger;
};

const artifact = {
  artifactRelativePath: "out/reels/clip-1.mp4",
  artifactHash: "sha256:abc123",
  sourceVideoId: "video-1",
  clipPackageId: 12,
  treatmentId: "audiogram-basic",
  treatmentVersion: "1",
  title: "A useful clip",
  caption: "A caption",
  accountId: "instagram-account-1",
};

test("changed approved captions clear every approval field; unchanged captions preserve approval", async (t) => {
  const ledger = await createTestLedger(t);
  const { id } = ledger.enqueueArtifact(artifact);
  const approved = ledger.approveItem(id, "2026-09-20T11:00:00.000Z");
  assert.equal(approved.approvedCaption, "A caption");
  assert.deepEqual(ledger.updateCaption(id, "A caption"), approved);
  const changed = ledger.updateCaption(id, "changed");
  assert.equal(changed.state, "queued");
  for (const key of ["approvedAt", "approvedArtifactHash", "approvedCaption", "approvalDecision", "scheduledAt"]) assert.equal(changed[key], null);
  assert.equal(ledger.claimDueApprovedItem("2026-09-20T12:00:00.000Z"), null);
});

test("claims require the specified account, item and an explicit caption snapshot including blank captions", async (t) => {
  const ledger = await createTestLedger(t);
  const { id } = ledger.enqueueArtifact({ ...artifact, caption: "" });
  assert.equal(ledger.approveItem(id, "2026-09-20T11:00:00Z").approvedCaption, "");
  assert.equal(ledger.claimDueApprovedItem("2026-09-20T12:00:00Z", { accountId: "other", itemId: id }), null);
  assert.equal(ledger.claimDueApprovedItem("2026-09-20T12:00:00Z", { accountId: artifact.accountId, itemId: "other" }), null);
  assert.equal(ledger.claimDueApprovedItem("2026-09-20T12:00:00Z", { accountId: artifact.accountId, itemId: id }).id, id);
});

test("two connections serialize caption invalidation against claiming in either order", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "publishing-race-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "queue.sqlite");
  const first = createPublishingLedger(path);
  const second = createPublishingLedger(path);
  t.after(() => first.close());
  t.after(() => second.close());
  const { id } = first.enqueueArtifact(artifact);
  first.approveItem(id, "2026-09-20T11:00:00Z");
  second.updateCaption(id, "changed");
  assert.equal(first.claimDueApprovedItem("2026-09-20T12:00:00Z"), null);
  second.approveItem(id, "2026-09-20T11:00:00Z");
  first.claimDueApprovedItem("2026-09-20T12:00:00Z");
  assert.throws(() => second.updateCaption(id, "changed again"), /state/);
  assert.equal(first.getPublishingItem(id).caption, "changed");
});

test("safe retries require fresh approval and clear stale execution identifiers", async (t) => {
  const ledger = await createTestLedger(t);
  const { id } = ledger.enqueueArtifact(artifact);
  ledger.approveItem(id, "2026-09-20T11:00:00Z");
  ledger.claimDueApprovedItem("2026-09-20T12:00:00Z");
  ledger.transitionItem(id, "uploading", "failed", { safeToRetry: true, containerId: "old" });
  assert.throws(() => ledger.transitionItem(id, "failed", "approved"), /Invalid transition/);
  const retried = ledger.retryFailedItem(id);
  assert.equal(retried.state, "queued");
  assert.equal(retried.containerId, null);
  assert.equal(retried.approvedCaption, null);
  assert.equal(retried.safeToRetry, false);
  assert.equal(retried.retryCount, 1);
});

test("unclassified failures and unknown outcomes cannot be retried", async (t) => {
  const ledger = await createTestLedger(t);
  const { id } = ledger.enqueueArtifact(artifact);
  ledger.approveItem(id, "2026-09-20T11:00:00Z");
  ledger.transitionItem(id, "approved", "failed");
  assert.throws(() => ledger.retryFailedItem(id), /safe|retry/);
  const other = ledger.enqueueArtifact({ ...artifact, artifactRelativePath: "other.mp4" });
  ledger.approveItem(other.id, "2026-09-20T11:00:00Z");
  ledger.claimDueApprovedItem("2026-09-20T12:00:00Z");
  ledger.recordUnknownOutcome(other.id, { errorCode: "TIMEOUT" });
  assert.throws(() => ledger.retryFailedItem(other.id), /safe|retry/);
});

test("legacy approval without caption snapshot is migrated back to review without losing artifacts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "publishing-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "queue.sqlite");
  const initial = createPublishingLedger(path);
  const { id } = initial.enqueueArtifact(artifact);
  initial.approveItem(id, "2026-09-20T11:00:00Z");
  initial.close();
  const db = new DatabaseSync(path);
  const columns = db.prepare("PRAGMA table_info(publishing_items)").all().map((c) => c.name);
  if (columns.includes("approved_caption")) db.exec("ALTER TABLE publishing_items DROP COLUMN approved_caption");
  if (columns.includes("safe_to_retry")) db.exec("ALTER TABLE publishing_items DROP COLUMN safe_to_retry");
  db.close();
  const migrated = createPublishingLedger(path);
  t.after(() => migrated.close());
  assert.equal(migrated.getPublishingItem(id).state, "queued");
  assert.equal(migrated.getPublishingItem(id).artifactHash, artifact.artifactHash);
  assert.equal(migrated.getPublishingItem(id).approvedAt, null);
  assert.equal(migrated.claimDueApprovedItem("2026-09-20T12:00:00Z"), null);
});

test("enqueues an artifact and returns it in the queue", async (t) => {
  const ledger = await createTestLedger(t);

  const first = ledger.enqueueArtifact(artifact);
  const second = ledger.enqueueArtifact(artifact);

  assert.equal(first.id, second.id);
  assert.equal(first.state, "queued");
  assert.equal(first.artifactRelativePath, artifact.artifactRelativePath);
  assert.equal(first.artifactHash, artifact.artifactHash);
  assert.equal(first.caption, artifact.caption);
  assert.equal(first.approvedAt, null);
  assert.deepEqual(ledger.getQueue(), [first]);
  assert.deepEqual(ledger.getPublishingItem(first.id), first);
});

test("updates a caption and approves an item with a schedule", async (t) => {
  const ledger = await createTestLedger(t);
  const item = ledger.enqueueArtifact(artifact);

  const updated = ledger.updateCaption(item.id, "An edited caption");
  const approved = ledger.approveItem(
    item.id,
    "2026-09-20T13:00:00.000Z",
  );

  assert.equal(updated.caption, "An edited caption");
  assert.equal(approved.state, "approved");
  assert.equal(approved.caption, "An edited caption");
  assert.equal(approved.scheduledAt, "2026-09-20T13:00:00.000Z");
  assert.equal(approved.approvedAt, "2026-09-20T12:00:00.000Z");
  assert.equal(approved.approvedArtifactHash, artifact.artifactHash);
});

test("allows a blank string caption and normalizes offset schedules to UTC", async (t) => {
  const ledger = await createTestLedger(t);
  const item = ledger.enqueueArtifact(artifact);
  assert.equal(ledger.updateCaption(item.id, "").caption, "");
  const approved = ledger.approveItem(item.id, "2026-09-20T18:00:00-06:00");
  assert.equal(approved.scheduledAt, "2026-09-21T00:00:00.000Z");
});

test("rejects a queued item and preserves the rejection reason", async (t) => {
  const ledger = await createTestLedger(t);
  const item = ledger.enqueueArtifact(artifact);

  const rejected = ledger.rejectItem(item.id, "Needs a shorter caption");

  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.approvalDecision, "rejected");
  assert.equal(rejected.rejectionReason, "Needs a shorter caption");
  assert.equal(rejected.rejectedAt, "2026-09-20T12:00:00.000Z");
});

test("refuses to transition when the current artifact hash differs from the approved hash", async (t) => {
  const ledger = await createTestLedger(t);
  const item = ledger.enqueueArtifact(artifact);
  ledger.approveItem(item.id, "2026-09-20T13:00:00.000Z");

  assert.throws(
    () =>
      ledger.transitionItem(item.id, "approved", "uploading", {
        artifactHash: "sha256:changed",
      }),
    /Artifact hash mismatch/,
  );
  assert.equal(ledger.getPublishingItem(item.id).state, "approved");
});

test("claims only the oldest due approved item atomically", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "publishing-claim-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "publishing.sqlite");
  const firstLedger = createPublishingLedger(path, {
    now: () => "2026-09-20T12:00:00.000Z",
  });
  const secondLedger = createPublishingLedger(path, {
    now: () => "2026-09-20T12:00:01.000Z",
  });
  t.after(() => firstLedger.close());
  t.after(() => secondLedger.close());

  const first = firstLedger.enqueueArtifact({
    ...artifact,
    artifactRelativePath: "out/reels/first.mp4",
  });
  const second = firstLedger.enqueueArtifact({
    ...artifact,
    artifactRelativePath: "out/reels/second.mp4",
    artifactHash: "sha256:def456",
  });
  firstLedger.approveItem(first.id, "2026-09-20T11:00:00.000Z");
  firstLedger.approveItem(second.id, "2026-09-20T11:30:00.000Z");

  const claimedByFirstWorker = firstLedger.claimDueApprovedItem(
    "2026-09-20T12:00:00.000Z",
  );
  const claimedBySecondWorker = secondLedger.claimDueApprovedItem(
    "2026-09-20T12:00:00.000Z",
  );

  assert.equal(claimedByFirstWorker.id, first.id);
  assert.equal(claimedByFirstWorker.state, "uploading");
  assert.equal(claimedBySecondWorker.id, second.id);
  assert.equal(claimedBySecondWorker.state, "uploading");
});

test("does not claim an item before its scheduled time", async (t) => {
  const ledger = await createTestLedger(t);
  const item = ledger.enqueueArtifact(artifact);
  ledger.approveItem(item.id, "2026-09-20T13:00:00.000Z");

  assert.equal(
    ledger.claimDueApprovedItem("2026-09-20T12:59:59.000Z"),
    null,
  );
  assert.equal(ledger.getPublishingItem(item.id).state, "approved");
});

test("rejects invalid state transitions and mismatched source states", async (t) => {
  const ledger = await createTestLedger(t);
  const item = ledger.enqueueArtifact(artifact);

  assert.throws(
    () => ledger.transitionItem(item.id, "queued", "published"),
    /Invalid transition: queued -> published/,
  );
  assert.throws(
    () => ledger.transitionItem(item.id, "approved", "uploading"),
    /Expected item .* to be approved, but it is queued/,
  );
});

test("records an unknown publish outcome with diagnostic details", async (t) => {
  const ledger = await createTestLedger(t);
  const item = ledger.enqueueArtifact(artifact);
  ledger.approveItem(item.id, "2026-09-20T11:00:00.000Z");
  ledger.transitionItem(item.id, "approved", "uploading");

  const unknown = ledger.recordUnknownOutcome(item.id, {
    containerId: "container-1",
    errorCode: "TIMEOUT",
    errorMessage: "Publish request timed out",
  });

  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.containerId, "container-1");
  assert.equal(unknown.errorCode, "TIMEOUT");
  assert.equal(unknown.errorMessage, "Publish request timed out");
  assert.deepEqual(unknown.unknownDetails, {
    containerId: "container-1",
    errorCode: "TIMEOUT",
    errorMessage: "Publish request timed out",
  });
});

test("sanitizes structured unknown details and preserves the first failure", async (t) => {
  const ledger = await createTestLedger(t);
  const item = ledger.enqueueArtifact(artifact);
  ledger.approveItem(item.id, "2026-09-20T11:00:00.000Z");
  ledger.transitionItem(item.id, "approved", "uploading");
  ledger.recordUnknownOutcome(item.id, {
    phase: "media_publish",
    errorCode: "TIMEOUT",
    responseBody: "access_token=secret",
  });
  const unknown = ledger.getPublishingItem(item.id);
  assert.equal(unknown.unknownDetails.errorCode, "TIMEOUT");
  assert.match(unknown.unknownDetails.responseBody, /REDACTED/);
  assert.doesNotMatch(JSON.stringify(unknown.unknownDetails), /secret/);
});
