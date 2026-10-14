import { createHash } from "node:crypto";
import { sanitizePublishingDiagnostic } from "./publishing-diagnostics.mjs";
import { openArtifact } from "./publishing-artifact.mjs";

export const recoveryFingerprint = snapshot => createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
export const classifyRecovery = (snapshot, diagnostic) => {
  const no = reasonCode => ({eligible:false, reasonCode});
  const {item, attempt} = snapshot ?? {};
  if (!item || !attempt) return no("MISSING_ITEM_OR_ATTEMPT");
  if (!attempt.container_id || !/^[0-9]+$/.test(attempt.container_id) || item.container_id !== attempt.container_id || attempt.item_id !== item.id) return no("CONTAINER_MISMATCH");
  if (item.media_id || attempt.media_id || item.published_at) return no("PUBLICATION_EVIDENCE");
  const legacy = item.state === "container_created" && attempt.phase === "upload_requested";
  const failed = item.state === "failed" && attempt.phase === "failed" && ["UPLOAD_PHASE_ERROR", "UPLOAD_REJECTED"].includes(attempt.error_code);
  if (!legacy && !failed) return no("PHASE_INELIGIBLE");
  if (item.approval_decision !== "approved" || !item.approved_at || !item.scheduled_at || !item.approved_artifact_hash || item.approved_caption !== item.caption || item.approved_artifact_hash !== item.artifact_hash) return no("APPROVAL_MISMATCH");
  if (!["ERROR", "IN_PROGRESS"].includes(diagnostic?.statusCode) || diagnostic?.uploadPhase !== "error" || diagnostic?.processingPhase !== "not_started") return no("UPLOAD_FAILURE_UNCONFIRMED");
  return {eligible:true, reasonCode:"CONFIRMED_UPLOAD_FAILURE"};
};

export const verifyRecoveryArtifact = async (config, snapshot) => {
  const artifact = await openArtifact(config.projectRoot, {
    artifactRelativePath:snapshot.item.artifact_relative_path,
    approvedArtifactHash:snapshot.item.approved_artifact_hash,
  }, config.artifactRoot);
  await artifact.handle.close();
};

export const inspectRecovery = async ({store, client, config, itemId, verifyArtifact = verifyRecoveryArtifact}) => {
  const snapshot = store.readSnapshot(itemId);
  if (!snapshot.item || snapshot.item.account_id !== config.accountId) return {eligible:false, reasonCode:"ACCOUNT_MISMATCH"};
  const preliminary = classifyRecovery(snapshot, {statusCode:"ERROR", uploadPhase:"error", processingPhase:"not_started"});
  if (!preliminary.eligible) return preliminary;
  await verifyArtifact(config, snapshot);
  await client.verifyAccount({accountId:config.accountId, pageId:config.pageId, username:config.username});
  const diagnostic = sanitizePublishingDiagnostic({...await client.getContainerStatus(snapshot.attempt.container_id), operation:"container_status"});
  if (recoveryFingerprint(store.readSnapshot(itemId)) !== recoveryFingerprint(snapshot)) return {eligible:false, reasonCode:"STALE_SNAPSHOT"};
  await verifyArtifact(config, snapshot);
  if (recoveryFingerprint(store.readSnapshot(itemId)) !== recoveryFingerprint(snapshot)) return {eligible:false, reasonCode:"STALE_SNAPSHOT"};
  const classification = classifyRecovery(snapshot, diagnostic);
  return {...classification, expected:{itemId, attemptId:snapshot.attempt.id, containerId:snapshot.attempt.container_id, fingerprint:recoveryFingerprint(snapshot)}, diagnostic};
};
