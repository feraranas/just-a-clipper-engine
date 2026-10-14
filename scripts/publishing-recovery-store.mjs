import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { classifyRecovery, recoveryFingerprint } from "./publishing-recovery.mjs";
import { sanitizePublishingDiagnostic } from "./publishing-diagnostics.mjs";

export const recoverySchema = `CREATE TABLE IF NOT EXISTS publishing_recoveries (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES publishing_items(id),
  old_attempt_id TEXT NOT NULL UNIQUE REFERENCES publishing_attempts(id),
  container_id TEXT NOT NULL, observed_at TEXT NOT NULL, reason_code TEXT NOT NULL,
  evidence_json TEXT NOT NULL, replacement_attempt_id TEXT UNIQUE REFERENCES publishing_attempts(id)
) STRICT;`;

export const readRecoverySnapshot = (db, itemId) => {
  try {
    const item = db.prepare("SELECT * FROM publishing_items WHERE id=?").get(itemId) ?? null;
    const columns = db.prepare("PRAGMA table_info(publishing_items)").all().map(r => r.name);
    if (!["approved_caption", "approved_artifact_hash", "safe_to_retry"].every(c => columns.includes(c))) throw new Error("Unsupported recovery schema");
    const attempt = db.prepare("SELECT * FROM publishing_attempts WHERE item_id=? ORDER BY sequence DESC LIMIT 1").get(itemId) ?? null;
    return {item, attempt};
  } catch { throw new Error("Unsupported recovery schema"); }
};

export const openRecoveryStore = path => {
  const db = new DatabaseSync(path, {readOnly:true, timeout:5000});
  return {
    close: () => db.close(), readSnapshot: itemId => readRecoverySnapshot(db, itemId),
    applyRecovery: ({expected, diagnostic, reasonCode}) => {
      const writer = new DatabaseSync(path, {timeout:5000});
      try {
        writer.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
        try {
          const snapshot = readRecoverySnapshot(writer, expected?.itemId);
          if (!expected || recoveryFingerprint(snapshot) !== expected.fingerprint || snapshot.attempt?.id !== expected.attemptId || snapshot.attempt?.container_id !== expected.containerId) throw new Error("Stale recovery snapshot");
          const evidence = sanitizePublishingDiagnostic(diagnostic);
          const classification = classifyRecovery(snapshot, evidence);
          if (!classification.eligible || classification.reasonCode !== reasonCode) throw new Error("Recovery ineligible");
          writer.exec(recoverySchema);
          const id = randomUUID(), now = new Date().toISOString();
          if (snapshot.attempt.phase !== "failed") writer.prepare(`UPDATE publishing_attempts SET phase='failed',error_code='UPLOAD_PHASE_ERROR',safe_to_retry=0,updated_at=? WHERE id=?`).run(now, expected.attemptId);
          writer.prepare("INSERT INTO publishing_diagnostics(attempt_id,observed_at,data_json) VALUES (?,?,?)").run(expected.attemptId, now, JSON.stringify(evidence));
          writer.prepare(`INSERT INTO publishing_recoveries(id,item_id,old_attempt_id,container_id,observed_at,reason_code,evidence_json) VALUES (?,?,?,?,?,?,?)`).run(id, expected.itemId, expected.attemptId, expected.containerId, now, reasonCode, JSON.stringify(evidence));
          writer.prepare(`UPDATE publishing_items SET state='queued',safe_to_retry=0,
            approval_decision=NULL,approved_at=NULL,approved_caption=NULL,approved_artifact_hash=NULL,scheduled_at=NULL,
            container_id=NULL,media_id=NULL,media_host_key=NULL,media_host_url=NULL,error_code=NULL,error_message=NULL,
            unknown_details_json=NULL,published_at=NULL,first_error_code=COALESCE(first_error_code,'UPLOAD_PHASE_ERROR'),updated_at=? WHERE id=?`).run(now, expected.itemId);
          writer.exec("COMMIT");
          return {status:"queued_for_reapproval", itemId:expected.itemId, recoveryId:id};
        } catch (error) { writer.exec("ROLLBACK"); throw error; }
      } finally { writer.close(); }
    },
  };
};
