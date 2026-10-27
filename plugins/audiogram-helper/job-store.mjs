import { resolveTemplateSelection } from "../../src/templates/catalog.mjs";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import {
  createMcpEventStore,
  migrateMcpEventStore,
} from "./mcp-event-store.mjs";

export function createJobStore(
  filename,
  {
    resolveSelection = resolveTemplateSelection,
    busyTimeoutMs = 5000,
    eventsEnabled = false,
    eventOwnerMode,
    ownerId,
    now,
  } = {},
) {
  if (
    !Number.isInteger(busyTimeoutMs) ||
    busyTimeoutMs < 0 ||
    busyTimeoutMs > 60000
  )
    throw new Error("Invalid SQLite busy timeout.");
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  chmodSync(filename, 0o600);
  chmodSync(path.dirname(filename), 0o700);
  db.exec(
    `PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=${busyTimeoutMs};`,
  );
  for (const suffix of ["-wal", "-shm"])
    if (existsSync(filename + suffix)) chmodSync(filename + suffix, 0o600);
  try {
    db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY, video_id TEXT NOT NULL, source_url TEXT NOT NULL,
      status TEXT NOT NULL, pid INTEGER, result_json TEXT, error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active_video ON jobs(video_id) WHERE status IN ('queued','running');`);
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(jobs)")
        .all()
        .map((row) => row.name),
    );
    if (!columns.has("render_key"))
      db.exec(
        "ALTER TABLE jobs ADD COLUMN render_key TEXT NOT NULL DEFAULT 'audiogram-basic@1'",
      );
    if (!columns.has("selection_json"))
      db.exec(
        `ALTER TABLE jobs ADD COLUMN selection_json TEXT NOT NULL DEFAULT '${JSON.stringify(resolveTemplateSelection().selection)}'`,
      );
    if (!columns.has("retry_of_job_id"))
      db.exec("ALTER TABLE jobs ADD COLUMN retry_of_job_id TEXT");
    migrateMcpEventStore(db, { eventOwnerMode, ownerId });
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* Preserve the migration error if rollback also fails. */
    }
    db.close();
    throw error;
  }
  const decode = (row) =>
    row && {
      jobId: row.job_id,
      videoId: row.video_id,
      sourceUrl: row.source_url,
      status: row.status,
      selection: JSON.parse(row.selection_json),
      renderKey: row.render_key,
      ...(row.retry_of_job_id ? { retryOfJobId: row.retry_of_job_id } : {}),
      pid: row.pid,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      runId: row.run_id,
      ownerId: row.owner_id,
      lastEventSequence: row.last_event_sequence,
      captureHealth: row.capture_health,
      finalizedAt: row.finalized_at,
      ...(row.result_json ? { result: JSON.parse(row.result_json) } : {}),
      ...(row.error ? { error: row.error } : {}),
    };
  const api = {
    createOrGetJob({ videoId, sourceUrl, selection, renderKey }) {
      const resolved = resolveSelection(selection);
      if (renderKey !== undefined && renderKey !== resolved.renderKey)
        throw new Error("Render identity does not match selection");
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db
          .prepare(
            "SELECT * FROM jobs WHERE video_id=? AND status IN ('queued','running')",
          )
          .get(videoId);
        if (existing) {
          if (existing.render_key !== resolved.renderKey) {
            throw Object.assign(
              new Error(
                "This video already has an active job for another template. Wait for that job to finish.",
              ),
              { code: "VIDEO_BUSY_DIFFERENT_TEMPLATE" },
            );
          }
          db.exec("COMMIT");
          return { job: decode(existing), created: false };
        }
        const jobId = randomUUID();
        db.prepare(
          "INSERT INTO jobs(job_id,video_id,source_url,status,render_key,selection_json,run_id,owner_id) VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          jobId,
          videoId,
          sourceUrl,
          "queued",
          resolved.renderKey,
          JSON.stringify(resolved.selection),
          jobId,
          ownerId ?? null,
        );
        const job = decode(
          db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId),
        );
        db.exec("COMMIT");
        return { job, created: true };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    createRetryJob({ priorJobId }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const prior = db
          .prepare("SELECT * FROM jobs WHERE job_id=?")
          .get(priorJobId);
        if (!prior) throw new Error("Audiogram job was not found.");
        if (!["failed", "partial"].includes(prior.status))
          throw new Error("Retry requires a terminal failed or partial job.");
        const jobId = randomUUID();
        db.prepare(
          "INSERT INTO jobs(job_id,video_id,source_url,status,retry_of_job_id,render_key,selection_json,run_id,owner_id) VALUES(?,?,?,'queued',?,?,?,?,?)",
        ).run(
          jobId,
          prior.video_id,
          prior.source_url,
          priorJobId,
          prior.render_key,
          prior.selection_json,
          jobId,
          prior.owner_id,
        );
        const job = db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId);
        db.exec("COMMIT");
        return { job: decode(job), created: true };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    markRunning(jobId, pid) {
      db.prepare(
        "UPDATE jobs SET status=CASE WHEN status='queued' THEN 'running' ELSE status END,pid=?,updated_at=CURRENT_TIMESTAMP WHERE job_id=?",
      ).run(pid, jobId);
    },
    setResult(jobId, result) {
      const existing = api.getJob(jobId);
      if (eventsEnabled || existing?.finalizedAt)
        return eventStore.finalizeJob(jobId, result, {
          capture:
            result.notificationHealth?.capture ??
            existing?.captureHealth ??
            "unknown",
        });
      db.prepare(
        "UPDATE jobs SET status=?,result_json=?,error=?,updated_at=CURRENT_TIMESTAMP WHERE job_id=?",
      ).run(
        result.status,
        JSON.stringify(result),
        typeof result.error === "string"
          ? result.error
          : (result.error?.message ?? null),
        jobId,
      );
    },
    setFailed(jobId, message) {
      if (eventsEnabled || api.getJob(jobId)?.finalizedAt)
        return eventStore.finalizeJob(jobId, {
          status: "failed",
          artifacts: [],
          failures: [
            {
              stage: "worker",
              code: "WORKER_FAILED",
              message: "Worker failed.",
            },
          ],
          error: message,
        });
      db.prepare(
        "UPDATE jobs SET status='failed',error=?,updated_at=CURRENT_TIMESTAMP WHERE job_id=?",
      ).run(message, jobId);
    },
    getJob(jobId) {
      return decode(db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobId));
    },
    close() {
      db.close();
    },
  };
  const eventStore = createMcpEventStore({ db, getJob: api.getJob, now });
  return Object.assign(api, eventStore);
}
