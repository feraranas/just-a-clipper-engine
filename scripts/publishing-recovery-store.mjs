import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  classifyRecovery,
  recoveryFingerprint,
} from "./publishing-recovery.mjs";
import { sanitizePublishingDiagnostic } from "./publishing-diagnostics.mjs";

export const recoverySchema = `CREATE TABLE IF NOT EXISTS publishing_recoveries (
  id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES publishing_items(id),
  old_attempt_id TEXT NOT NULL UNIQUE REFERENCES publishing_attempts(id),
  container_id TEXT NOT NULL, observed_at TEXT NOT NULL, reason_code TEXT NOT NULL,
  evidence_json TEXT NOT NULL, replacement_attempt_id TEXT UNIQUE REFERENCES publishing_attempts(id)
) STRICT;`;

export const readRecoverySnapshot = (db, itemId) => {
  try {
    const item =
      db.prepare("SELECT * FROM publishing_items WHERE id=?").get(itemId) ??
      null;
    const columns = db
      .prepare("PRAGMA table_info(publishing_items)")
      .all()
      .map((r) => r.name);
    if (
      !["approved_caption", "approved_artifact_hash", "safe_to_retry"].every(
        (c) => columns.includes(c),
      )
    )
      throw new Error("Unsupported recovery schema");
    const attempt =
      db
        .prepare(
          "SELECT * FROM publishing_attempts WHERE item_id=? ORDER BY sequence DESC LIMIT 1",
        )
        .get(itemId) ?? null;
    return { item, attempt };
  } catch {
    throw new Error("Unsupported recovery schema");
  }
};

export const openRecoveryStore = (path) => {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  return {
    close: () => db.close(),
    readSnapshot: (itemId) => readRecoverySnapshot(db, itemId),
    applyRecovery: ({ expected, diagnostic, reasonCode }) => {
      const writer = new DatabaseSync(path, { timeout: 5000 });
      try {
        writer.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
        try {
          const snapshot = readRecoverySnapshot(writer, expected?.itemId);
          if (
            !expected ||
            recoveryFingerprint(snapshot) !== expected.fingerprint ||
            snapshot.attempt?.id !== expected.attemptId ||
            snapshot.attempt?.container_id !== expected.containerId
          )
            throw new Error("Stale recovery snapshot");
          const evidence = sanitizePublishingDiagnostic(diagnostic);
          const classification = classifyRecovery(snapshot, evidence);
          if (
            !classification.eligible ||
            classification.reasonCode !== reasonCode
          )
            throw new Error("Recovery ineligible");
          writer.exec(recoverySchema);
          const id = randomUUID(),
            now = new Date().toISOString();
          if (snapshot.attempt.phase !== "failed")
            writer
              .prepare(
                `UPDATE publishing_attempts SET phase='failed',error_code='UPLOAD_PHASE_ERROR',safe_to_retry=0,updated_at=? WHERE id=?`,
              )
              .run(now, expected.attemptId);
          else if (snapshot.attempt.safe_to_retry !== 0)
            writer
              .prepare(
                "UPDATE publishing_attempts SET safe_to_retry=0,updated_at=? WHERE id=?",
              )
              .run(now, expected.attemptId);
          writer
            .prepare(
              "INSERT INTO publishing_diagnostics(attempt_id,observed_at,data_json) VALUES (?,?,?)",
            )
            .run(expected.attemptId, now, JSON.stringify(evidence));
          writer
            .prepare(
              `INSERT INTO publishing_recoveries(id,item_id,old_attempt_id,container_id,observed_at,reason_code,evidence_json) VALUES (?,?,?,?,?,?,?)`,
            )
            .run(
              id,
              expected.itemId,
              expected.attemptId,
              expected.containerId,
              now,
              reasonCode,
              JSON.stringify(evidence),
            );
          writer
            .prepare(
              `UPDATE publishing_items SET state='queued',safe_to_retry=0,
            approval_decision=NULL,approved_at=NULL,approved_caption=NULL,approved_artifact_hash=NULL,scheduled_at=NULL,
            container_id=NULL,media_id=NULL,media_host_key=NULL,media_host_url=NULL,error_code=NULL,error_message=NULL,
            unknown_details_json=NULL,published_at=NULL,first_error_code=COALESCE(first_error_code,'UPLOAD_PHASE_ERROR'),updated_at=? WHERE id=?`,
            )
            .run(now, expected.itemId);
          writer.exec("COMMIT");
          return {
            status: "queued_for_reapproval",
            itemId: expected.itemId,
            recoveryId: id,
          };
        } catch (error) {
          writer.exec("ROLLBACK");
          throw error;
        }
      } finally {
        writer.close();
      }
    },
  };
};

const historyCodes = new Set([
  "UPLOAD_PHASE_ERROR",
  "PROCESSING_PHASE_ERROR",
  "UPLOAD_REJECTED",
  "CREATE_REJECTED",
  "CREATE_OUTCOME_UNCERTAIN",
  "PUBLISH_OUTCOME_UNCERTAIN",
  "PUBLISHED_ID_UNCONFIRMED",
  "ARTIFACT_INVALID",
  "ARTIFACT_CHANGED",
  "CONTAINER_ERROR",
  "CONTAINER_EXPIRED",
]);
const outcome = (row) => {
  if (row.phase === "published") return "Published";
  if (
    row.phase === "publish_requested" ||
    ["PUBLISH_OUTCOME_UNCERTAIN", "PUBLISHED_ID_UNCONFIRMED"].includes(
      row.error_code,
    )
  )
    return "Publication outcome unknown";
  if (
    row.phase === "create_requested" ||
    row.error_code === "CREATE_OUTCOME_UNCERTAIN"
  )
    return "Container creation outcome unknown";
  if (row.phase === "failed")
    return ["UPLOAD_PHASE_ERROR", "UPLOAD_REJECTED"].includes(row.error_code)
      ? "Video upload failed"
      : row.error_code === "PROCESSING_PHASE_ERROR"
        ? "Video processing failed"
        : "Publishing failed";
  return (
    {
      claimed: "Attempt started",
      container_created: "Upload not started",
      upload_requested: "Upload pending",
      processing: "Still processing",
    }[row.phase] ?? "Outcome unknown"
  );
};

export const readPublishingHistory = (path, itemId) => {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5000 });
  try {
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name),
    );
    if (!tables.has("publishing_attempts")) return [];
    const rows = db
      .prepare(
        "SELECT * FROM publishing_attempts WHERE item_id=? ORDER BY sequence DESC LIMIT 20",
      )
      .all(itemId);
    return rows.map((row) => {
      const recovery = tables.has("publishing_recoveries")
        ? db
            .prepare(
              "SELECT observed_at FROM publishing_recoveries WHERE old_attempt_id=?",
            )
            .get(row.id)
        : null;
      let evidence = {};
      if (tables.has("publishing_diagnostics")) {
        const diagnostic = db
          .prepare(
            "SELECT data_json FROM publishing_diagnostics WHERE attempt_id=? ORDER BY sequence DESC LIMIT 1",
          )
          .get(row.id);
        try {
          evidence = sanitizePublishingDiagnostic(
            JSON.parse(diagnostic?.data_json ?? "{}"),
          );
        } catch {
          /* corrupt historical diagnostic does not erase attempt */
        }
      }
      return {
        attemptId: row.id,
        createdAt: row.created_at,
        outcome: outcome(row),
        errorCode: historyCodes.has(row.error_code) ? row.error_code : null,
        providerCodes: evidence.providerCodes ?? [],
        recoveredAt: recovery?.observed_at ?? null,
      };
    });
  } finally {
    db.close();
  }
};
