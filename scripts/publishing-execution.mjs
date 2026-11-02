import { randomUUID } from "node:crypto";
import { sanitizePublishingDiagnostic } from "./publishing-diagnostics.mjs";
import { DatabaseSync } from "node:sqlite";
import { recoverySchema } from "./publishing-recovery-store.mjs";
import { mkdir, open, readFile, unlink, rmdir, realpath } from "node:fs/promises";

const edges = {
  claimed: ["create_requested", "failed"],
  create_requested: ["container_created", "failed", "unknown"],
  container_created: ["upload_requested", "failed"],
  upload_requested: ["processing", "failed", "unknown"],
  processing: ["publish_requested", "failed", "unknown"],
  publish_requested: ["published", "unknown"],
  published: [], failed: [], unknown: [],
};
const states = { claimed: "uploading", create_requested: "uploading", container_created: "container_created", upload_requested: "container_created", processing: "processing", publish_requested: "processing", published: "published", failed: "failed", unknown: "unknown" };
const map = (row) => row && ({ id: row.id, itemId: row.item_id, phase: row.phase, containerId: row.container_id, uploadUri: row.upload_uri, mediaId: row.media_id, errorCode: row.error_code, safeToRetry: row.safe_to_retry === 1, sequence: row.sequence });

export const createPublishingExecution = (dbPath) => {
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS publishing_attempts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      item_id TEXT NOT NULL REFERENCES publishing_items(id), phase TEXT NOT NULL,
      container_id TEXT, upload_uri TEXT, media_id TEXT, error_code TEXT,
      safe_to_retry INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS publishing_diagnostics (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL REFERENCES publishing_attempts(id),
      observed_at TEXT NOT NULL, data_json TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS publishing_diagnostics_attempt_idx ON publishing_diagnostics(attempt_id, sequence);`);
  db.exec(recoverySchema);
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const getAttempt = (itemId) => map(db.prepare("SELECT * FROM publishing_attempts WHERE item_id = ? ORDER BY sequence DESC LIMIT 1").get(itemId));
  const replacementAuthorization = last => last?.phase === "failed" && db.prepare("SELECT id FROM publishing_recoveries WHERE old_attempt_id=? AND replacement_attempt_id IS NULL").get(last.id);
  return {
    close: () => db.close(), getAttempt,
    canBeginReplacement: itemId => Boolean(replacementAuthorization(getAttempt(itemId))),
    getDiagnostics: (itemId) => db.prepare(`SELECT d.sequence, d.attempt_id, d.observed_at, d.data_json
      FROM publishing_diagnostics d JOIN publishing_attempts a ON a.id=d.attempt_id
      WHERE a.item_id=? ORDER BY d.sequence DESC LIMIT 100`).all(itemId).reverse().map(row => ({
        sequence: row.sequence, attemptId: row.attempt_id, observedAt: row.observed_at, data: JSON.parse(row.data_json),
      })),
    recordDiagnostic: (attemptId, input) => transaction(() => {
      const row = db.prepare("SELECT * FROM publishing_attempts WHERE id=?").get(attemptId);
      if (!row || getAttempt(row.item_id).id !== attemptId) throw new Error("Diagnostic attempt mismatch");
      const data = sanitizePublishingDiagnostic(input);
      const phaseError = data.operation === "container_status" && data.statusCode !== "PUBLISHED"
        && ["upload_requested", "processing"].includes(row.phase)
        ? data.uploadPhase === "error" ? "UPLOAD_PHASE_ERROR"
          : data.processingPhase === "error" ? "PROCESSING_PHASE_ERROR" : null
        : null;
      const now = new Date().toISOString();
      if (phaseError) {
        const item = db.prepare("SELECT state FROM publishing_items WHERE id=?").get(row.item_id);
        if (item?.state !== states[row.phase]) throw new Error("Execution state mismatch");
        db.prepare("UPDATE publishing_attempts SET phase='failed',error_code=?,safe_to_retry=0,updated_at=? WHERE id=?")
          .run(phaseError, now, attemptId);
        db.prepare(`UPDATE publishing_items SET state='failed',error_code=?,
          first_error_code=COALESCE(first_error_code,?),safe_to_retry=0,updated_at=? WHERE id=?`)
          .run(phaseError, phaseError, now, row.item_id);
      }
      db.prepare("INSERT INTO publishing_diagnostics(attempt_id,observed_at,data_json) VALUES (?,?,?)")
        .run(attemptId, now, JSON.stringify(data));
    }),
    beginAttempt: (itemId) => transaction(() => {
      const item = db.prepare("SELECT * FROM publishing_items WHERE id = ?").get(itemId);
      if (!item || item.state !== "uploading") throw new Error("Cannot begin attempt in current state");
      const last = getAttempt(itemId);
      const authorization = replacementAuthorization(last);
      if (last && !(last.phase === "failed" && last.safeToRetry) && !authorization) throw new Error("Attempt already active or terminal");
      if (authorization && (item.approval_decision !== "approved" || !item.approved_at || !item.scheduled_at || item.caption !== item.approved_caption || item.artifact_hash !== item.approved_artifact_hash)) throw new Error("Replacement requires fresh approval");
      const id = randomUUID(), now = new Date().toISOString();
      db.prepare("INSERT INTO publishing_attempts(id,item_id,phase,created_at,updated_at) VALUES (?,?,'claimed',?,?)").run(id, itemId, now, now);
      if (authorization) db.prepare("UPDATE publishing_recoveries SET replacement_attempt_id=? WHERE id=? AND replacement_attempt_id IS NULL").run(id, authorization.id);
      return id;
    }),
    checkpoint: (id, phase, patch = {}) => transaction(() => {
      const row = db.prepare("SELECT * FROM publishing_attempts WHERE id = ?").get(id);
      if (!row || !edges[row.phase]?.includes(phase)) throw new Error("Invalid execution phase transition");
      const item = db.prepare("SELECT * FROM publishing_items WHERE id = ?").get(row.item_id);
      if (getAttempt(row.item_id).id !== id || item.state !== states[row.phase]) throw new Error("Execution state mismatch");
      for (const key of Object.keys(patch)) if (!["containerId", "uploadUri", "mediaId", "errorCode", "safeToRetry"].includes(key)) throw new Error("Unsupported checkpoint patch");
      for (const key of ["containerId", "mediaId"]) if (patch[key] !== undefined && !/^[0-9]+$/.test(patch[key])) throw new Error(`Invalid ${key}`);
      if (patch.errorCode !== undefined && !/^[A-Z0-9_]{1,80}$/.test(patch.errorCode)) throw new Error("Invalid errorCode");
      if (patch.uploadUri !== undefined && !/^https:\/\/rupload\.facebook\.com\/ig-api-upload\/v[0-9]+\.[0-9]+\/[0-9]+$/.test(patch.uploadUri)) throw new Error("Invalid uploadUri");
      if (phase === "container_created" && (!patch.containerId || !patch.uploadUri)) throw new Error("Container checkpoint requires ID and URI");
      if (phase === "published" && !patch.mediaId) throw new Error("Published checkpoint requires mediaId");
      if (patch.safeToRetry && (phase !== "failed" || row.phase === "publish_requested")) throw new Error("Unsafe retry classification");
      const now = new Date().toISOString();
      const containerId = patch.containerId ?? row.container_id;
      const mediaId = patch.mediaId ?? row.media_id;
      const errorCode = patch.errorCode ?? null;
      const safe = Number(patch.safeToRetry === true);
      db.prepare(`UPDATE publishing_attempts SET phase=?, container_id=?, upload_uri=?, media_id=?, error_code=?, safe_to_retry=?, updated_at=? WHERE id=?`).run(phase, containerId, patch.uploadUri ?? row.upload_uri, mediaId, errorCode, safe, now, id);
      db.prepare(`UPDATE publishing_items SET state=?, container_id=?, media_id=?, error_code=?,
        first_error_code=COALESCE(first_error_code,?), safe_to_retry=?, updated_at=?,
        published_at=CASE WHEN ?='published' THEN ? ELSE published_at END WHERE id=?`).run(states[phase], containerId, mediaId, errorCode, errorCode, safe, now, phase, now, row.item_id);
      return getAttempt(row.item_id);
    }),
  };
};

// Never steal by age. An abandoned directory is intentionally operator-visible.
export const acquireWorkerLock = async (dbPath) => {
  const path = `${await realpath(dbPath)}.worker-lock`;
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (error.code === "EEXIST") throw new Error("Publishing worker busy; inspect lock owner before manual recovery"); throw error; }
  const ownerId = randomUUID();
  const handle = await open(`${path}/owner.json`, "wx", 0o600);
  await handle.writeFile(JSON.stringify({ ownerId, pid: process.pid, startedAt: new Date().toISOString() }));
  let lost = false;
  const assertOwned = async () => {
    try {
      const owner = JSON.parse(await readFile(`${path}/owner.json`, "utf8"));
      if (lost || owner.ownerId !== ownerId) throw new Error("lost");
    } catch { lost = true; throw new Error("Worker ownership lost"); }
  };
  // Heartbeat updates the held file, not an unverified replacement path.
  const heartbeat = setInterval(async () => {
    try { await assertOwned(); const now = new Date(); await handle.utimes(now, now); }
    catch { lost = true; clearInterval(heartbeat); }
  }, 5000);
  heartbeat.unref();
  return { assertOwned, release: async () => {
    clearInterval(heartbeat);
    try { await assertOwned(); await unlink(`${path}/owner.json`); await rmdir(path); }
    finally { await handle.close(); }
  } };
};
