import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
