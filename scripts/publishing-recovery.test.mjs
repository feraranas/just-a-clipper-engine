import test from "node:test";
import assert from "node:assert/strict";
import { classifyRecovery, inspectRecovery } from "./publishing-recovery.mjs";
import { recoveryFixture } from "./test-support/recovery-fixture.mjs";
import { openRecoveryStore } from "./publishing-recovery-store.mjs";
import { writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

export const eligibleSnapshot = () => ({
  item: { id: "item", state: "container_created", container_id: "123", account_id: "2", caption: "approved", approved_caption: "approved", artifact_hash: "sha256:abc", approved_artifact_hash: "sha256:abc", approval_decision: "approved", approved_at: "2026-10-13T00:00:00Z", scheduled_at: "2026-10-13T00:00:00Z" },
  attempt: { id: "attempt", item_id: "item", phase: "upload_requested", container_id: "123" },
});
export const uploadError = { statusCode: "IN_PROGRESS", uploadPhase: "error", processingPhase: "not_started", providerCodes: [-1] };

test("confirmed upload failure and legacy active upload qualify", () => {
  assert.equal(classifyRecovery(eligibleSnapshot(), uploadError).eligible, true);
  const s = eligibleSnapshot(); s.item.state = "failed"; s.attempt.phase = "failed"; s.attempt.error_code = "UPLOAD_PHASE_ERROR";
  assert.equal(classifyRecovery(s, { ...uploadError, statusCode: "ERROR" }).eligible, true);
});
for (const [name, mutate, diagnostic] of [
  ["pending", () => {}, { ...uploadError, uploadPhase: "in_progress" }],
  ...["FINISHED", "PUBLISHED", "EXPIRED"].map(statusCode => [statusCode, () => {}, { ...uploadError, statusCode }]),
  ["processing-only", () => {}, { ...uploadError, uploadPhase: "complete", processingPhase: "error" }],
  ["contradictory processing", () => {}, { ...uploadError, processingPhase: "complete" }],
  ["missing processing evidence", () => {}, { uploadPhase: "error", statusCode: "ERROR" }],
  ["missing ID", s => { s.attempt.container_id = null; }],
  ...["unknown", "create_requested", "publish_requested", "processing"].map(phase => [phase, s => { s.attempt.phase = phase; }]),
  ["media ID", s => { s.attempt.media_id = "789"; }],
  ["item media ID", s => { s.item.media_id = "789"; }],
  ["published timestamp", s => { s.item.published_at = "today"; }],
  ["missing approval", s => { s.item.approval_decision = null; }],
  ["caption changed", s => { s.item.caption = "new"; }],
  ["hash changed", s => { s.item.artifact_hash = "new"; }],
  ["container mismatch", s => { s.item.container_id = "999"; }],
  ["processing failure", s => { s.item.state = "failed"; s.attempt.phase = "failed"; s.attempt.error_code = "PROCESSING_PHASE_ERROR"; }],
]) test(`blocks ${name}`, () => {
  const s = eligibleSnapshot(); mutate(s);
  assert.equal(classifyRecovery(s, diagnostic ?? uploadError).eligible, false);
});
test("inspection rejects changed persisted state during provider reads and omits secrets", async () => {
  const s = eligibleSnapshot(); let reads = 0;
  const store = { readSnapshot: () => { reads++; return structuredClone(s); } };
  const client = { verifyAccount: async () => {}, getContainerStatus: async () => { s.item.caption = "changed"; return { ...uploadError, token: "secret" }; } };
  const result = await inspectRecovery({store, client, config: {accountId: "2"}, itemId: "item", verifyArtifact: async () => {}});
  assert.equal(result.reasonCode, "STALE_SNAPSHOT"); assert.equal(reads, 2);
  assert.ok(!JSON.stringify(result).includes("secret"));
});
test("account mismatch blocks before provider reads", async () => {
  const result = await inspectRecovery({store: {readSnapshot: eligibleSnapshot}, client: {}, config: {accountId:"3"}, itemId:"item"});
  assert.equal(result.reasonCode, "ACCOUNT_MISMATCH");
});
for (const change of ["missing", "changed", "symlink"]) test(`inspection rejects ${change} artifact`, async t => {
  const f = await recoveryFixture(t), store = openRecoveryStore(f.path); t.after(()=>store.close());
  const path = join(f.root, "clip.mp4");
  if (change === "changed") await writeFile(path, "tampered");
  else { await rm(path); if (change === "symlink") await symlink("/etc/hosts", path); }
  await assert.rejects(inspectRecovery({...f, store}));
});
test("inspection uses GET-only client and returns only sanitized evidence", async t => {
  const f = await recoveryFixture(t), store = openRecoveryStore(f.path); t.after(()=>store.close());
  f.client.getContainerStatus = async () => ({...uploadError, token:"secret", status:"raw secret", uploadUri:"secret"});
  const result = await inspectRecovery({...f, store});
  assert.equal(result.eligible, true); assert.ok(!JSON.stringify(result).includes("secret"));
});
test("artifact mutation during provider reads cannot qualify for recovery", async t => {
  const f=await recoveryFixture(t),store=openRecoveryStore(f.path); t.after(()=>store.close());
  f.client.getContainerStatus=async()=>{await writeFile(join(f.root,"clip.mp4"),"changed during GET"); return uploadError;};
  await assert.rejects(inspectRecovery({...f,store}), /integrity/);
});
