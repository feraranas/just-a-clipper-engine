import { randomUUID } from "node:crypto";
import {
  EVENT_NAMES,
  EventEnvelopeSchema,
  buildProgressEvent,
  buildJobFinishedEvent,
} from "./mcp-event-contract.mjs";

// Deterministic comparison and persistence; SQL transactions never span I/O.
export function canonicalJson(value) {
  const ordered = (input) =>
    Array.isArray(input)
      ? input.map(ordered)
      : input && typeof input === "object"
        ? Object.fromEntries(
            Object.keys(input)
              .sort()
              .filter((key) => input[key] !== undefined)
              .map((key) => [key, ordered(input[key])]),
          )
        : input;
  return JSON.stringify(ordered(value));
}

// Called inside the owning jobs migration transaction, never a nested BEGIN.
export function migrateMcpEventStore(db, { eventOwnerMode, ownerId } = {}) {
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(jobs)")
      .all()
      .map((column) => column.name),
  );
  for (const [name, definition] of [
    ["owner_id", "TEXT"],
    ["run_id", "TEXT"],
    ["last_event_sequence", "INTEGER NOT NULL DEFAULT 0"],
    ["capture_health", "TEXT NOT NULL DEFAULT 'unknown'"],
    ["finalized_at", "TEXT"],
  ])
    if (!columns.has(name))
      db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${definition}`);
  db.exec("UPDATE jobs SET run_id=job_id WHERE run_id IS NULL");
  if (eventOwnerMode === "private-tunnel") {
    if (ownerId !== "local-owner")
      throw new Error("Private owner migration requires local-owner.");
    db.prepare("UPDATE jobs SET owner_id=? WHERE owner_id IS NULL").run(
      ownerId,
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_event_schema (version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS event_outbox (
      event_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(job_id),
      source_id TEXT,
      sequence INTEGER NOT NULL CHECK(sequence>0),
      event_name TEXT NOT NULL CHECK(event_name IN ('audiogram.job.progress','audiogram.job.finished')),
      timestamp TEXT NOT NULL,
      fact_json TEXT,
      envelope_json TEXT NOT NULL CHECK(length(CAST(envelope_json AS BLOB))<=65536),
      UNIQUE(job_id,source_id), UNIQUE(job_id,sequence)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS event_one_finish ON event_outbox(job_id)
      WHERE event_name='audiogram.job.finished';
    INSERT OR IGNORE INTO mcp_event_schema(version) VALUES(1);
  `);
}

export function createMcpEventStore({
  db,
  getJob,
  now = () => new Date().toISOString(),
}) {
  const transaction = (operation) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const requiredJob = (jobId) => {
    const job = getJob(jobId);
    if (!job) throw new Error("Audiogram job was not found.");
    return job;
  };
  const decode = (row) =>
    row ? EventEnvelopeSchema.parse(JSON.parse(row.envelope_json)) : null;
  const insert = (jobId, event, sourceId = null, fact = null) => {
    db.prepare(
      `INSERT INTO event_outbox(event_id,job_id,source_id,sequence,event_name,timestamp,fact_json,envelope_json)
      VALUES(?,?,?,?,?,?,?,?)`,
    ).run(
      event.eventId,
      jobId,
      sourceId,
      event.data.sequence,
      event.name,
      event.timestamp,
      fact ? canonicalJson(fact) : null,
      canonicalJson(event),
    );
  };
  return {
    appendProgress({ jobId, sourceId, fact }) {
      return transaction(() => {
        const job = requiredJob(jobId);
        if (sourceId !== fact?.source_id)
          throw new Error("Invalid source identity.");
        // Validate even duplicate writes, and reject reused source IDs with different facts.
        const event = buildProgressEvent({
          job,
          fact,
          eventId: randomUUID(),
          sequence: job.lastEventSequence + 1,
          timestamp: now(),
        });
        const prior = db
          .prepare("SELECT * FROM event_outbox WHERE job_id=? AND source_id=?")
          .get(jobId, sourceId);
        if (prior) {
          if (prior.fact_json !== canonicalJson(fact))
            throw new Error("Progress source conflict.");
          return { event: decode(prior), created: false };
        }
        if (!["queued", "running"].includes(job.status))
          throw new Error("Job is finalized.");
        db.prepare("UPDATE jobs SET last_event_sequence=? WHERE job_id=?").run(
          event.data.sequence,
          jobId,
        );
        insert(jobId, event, sourceId, fact);
        return { event, created: true };
      });
    },
    finalizeJob(jobId, result, { capture = "unknown" } = {}) {
      return transaction(() => {
        const job = requiredJob(jobId);
        const event = buildJobFinishedEvent({
          job,
          result,
          capture,
          eventId: randomUUID(),
          sequence: job.lastEventSequence + 1,
          timestamp: now(),
        });
        const prior = db
          .prepare(
            "SELECT * FROM event_outbox WHERE job_id=? AND event_name='audiogram.job.finished'",
          )
          .get(jobId);
        if (prior) {
          const existing = decode(prior);
          if (
            canonicalJson(job.result) !== canonicalJson(result) ||
            existing.data.progress_history !== capture
          )
            throw new Error("Final result conflict.");
          return { job, event: existing, created: false };
        }
        // A legacy terminal row is only materialized by an authorized caller after verification.
        if (
          !["queued", "running"].includes(job.status) &&
          (job.status !== result.status ||
            (job.result && canonicalJson(job.result) !== canonicalJson(result)))
        )
          throw new Error("Legacy final result conflict.");
        db.prepare(
          `UPDATE jobs SET status=?,result_json=?,error=?,last_event_sequence=?,capture_health=?,
          finalized_at=?,updated_at=CURRENT_TIMESTAMP WHERE job_id=?`,
        ).run(
          result.status,
          canonicalJson(result),
          typeof result.error === "string"
            ? result.error
            : (result.error?.message ?? null),
          event.data.sequence,
          capture,
          event.timestamp,
          jobId,
        );
        insert(jobId, event);
        return { job: requiredJob(jobId), event, created: true };
      });
    },
    getEvent(eventId) {
      return decode(
        db.prepare("SELECT * FROM event_outbox WHERE event_id=?").get(eventId),
      );
    },
    listJobEvents({ jobId, name, afterSequence = 0, limit = 100 } = {}) {
      requiredJob(jobId);
      if (
        (name !== undefined && !EVENT_NAMES.includes(name)) ||
        !Number.isSafeInteger(afterSequence) ||
        afterSequence < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 1000
      )
        throw new Error("Invalid event query.");
      return db
        .prepare(
          `SELECT * FROM event_outbox WHERE job_id=? AND sequence>?
        ${name === undefined ? "" : "AND event_name=?"} ORDER BY sequence LIMIT ?`,
        )
        .all(
          ...(name === undefined
            ? [jobId, afterSequence, limit]
            : [jobId, afterSequence, name, limit]),
        )
        .map(decode);
    },
    getCaptureHealth(jobId) {
      return requiredJob(jobId).captureHealth;
    },
  };
}
