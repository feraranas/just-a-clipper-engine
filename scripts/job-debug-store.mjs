import { DatabaseSync } from "node:sqlite";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { normalizePipelineEvent } from "./pipeline-logger.mjs";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = [
  "queued",
  "running",
  "complete",
  "partial",
  "failed",
  "no_clips",
];
const stages = [
  "worker",
  "intake",
  "metadata",
  "setup",
  "transcript",
  "selection",
  "jev",
  "assets",
  "render",
  "artifact_verification",
];
const failureCodes = new Set([
  "WORKER_FAILED",
  "WORKER_PROCESS_FAILED",
  "CLI_CONTRACT_INVALID",
  "WORKER_EXITED",
  "INTAKE_FAILED",
  "INVALID_URL",
  "METADATA_FAILED",
  "PIPELINE_SETUP_FAILED",
  "TRANSCRIPT_FAILED",
  "SELECTION_FAILED",
  "SELECTION_INVALID_CUE",
  "SELECTION_INVALID_OUTPUT",
  "JEV_FAILED",
  "ASSET_FAILED",
  "RENDER_FAILED",
  "ARTIFACT_VERIFICATION_FAILED",
  "NO_VERIFIED_ARTIFACTS",
  "PROCESSING_FAILED",
]);
const deliveryCodes = new Set([
  "timeout",
  "network_error",
  "unsafe_destination",
  "response_too_large",
  "invalid_event",
  "secret_unavailable",
  "ARTIFACT_UNAVAILABLE",
  "delivery_failed",
  "attempts_exhausted",
]);
const eventNames = ["audiogram.job.progress", "audiogram.job.finished"];
export const debugError = (code, status = 400) =>
  Object.assign(new Error(code), { code, status });
const invalid = () => debugError("Invalid diagnostic request");
function jobId(value) {
  if (typeof value !== "string" || !uuid.test(value)) throw invalid();
  return value;
}
function limitValue(value, fallback = 100, max = 500) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw invalid();
  return n;
}
const encode = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
function decode(value, kind) {
  if (!value) return null;
  try {
    if (
      typeof value !== "string" ||
      value.length > 1024 ||
      !/^[\w-]+$/.test(value)
    )
      throw invalid();
    const result = JSON.parse(Buffer.from(value, "base64url").toString());
    if (result.kind !== kind) throw invalid();
    return result;
  } catch {
    throw debugError("Invalid cursor");
  }
}
const parse = (value) => {
  try {
    return JSON.parse(value ?? "null");
  } catch {
    return null;
  }
};
const safeChoice = (value, values, fallback = "unknown") =>
  values.includes(value) ? value : fallback;
const iso = (value) =>
  Number.isFinite(value) && value >= 0 && value < 8640000000000000
    ? new Date(value).toISOString()
    : null;
const text = (value, max = 240) =>
  typeof value === "string" ? value.slice(0, max) : null;
const identifier = (value) =>
  /^[\w.@:-]{1,180}$/.test(String(value ?? "")) ? String(value) : null;
function summary(row) {
  const result = parse(row.result_json);
  const artifacts = result?.artifactPaths ?? result?.artifacts;
  return {
    jobId: row.job_id,
    videoId: text(row.video_id, 128),
    status: safeChoice(row.status, statuses),
    title: text(result?.title ?? result?.source?.title),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    artifactCount: Array.isArray(artifacts) ? artifacts.length : 0,
    capture: safeChoice(row.capture_health, [
      "complete",
      "incomplete",
      "unknown",
    ]),
    failures: Array.isArray(result?.failures)
      ? result.failures.slice(0, 100).map((f) => ({
          stage: safeChoice(f?.stage, stages),
          code: failureCodes.has(f?.code) ? f.code : "PROCESSING_FAILED",
          packageId: identifier(f?.packageId),
        }))
      : [],
    summaryIncomplete: row.result_json?.length >= 262144,
    diagnosticsIncomplete: result?.diagnosticsIncomplete === true,
  };
}
const jobColumns =
  "job_id,video_id,status,created_at,updated_at,substr(result_json,1,262144) AS result_json";
function hasTable(db, name) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

export function createJobDebugReader({
  jobsDbPath,
  diagnosticsRoot,
  sourceLabel = "Local jobs",
}) {
  function read(operation) {
    let db;
    try {
      db = new DatabaseSync(jobsDbPath, { readOnly: true });
      db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
      return operation(db);
    } catch (error) {
      if (error.status) throw error;
      throw debugError("Job database unavailable", 503);
    } finally {
      db?.close();
    }
  }
  function requireJob(db, id) {
    jobId(id);
    const fields = db.prepare("PRAGMA table_info(jobs)").all();
    const capture = fields.some((c) => c.name === "capture_health")
      ? "capture_health"
      : "'unknown' AS capture_health";
    const row = db
      .prepare(`SELECT ${jobColumns},${capture} FROM jobs WHERE job_id=?`)
      .get(id);
    if (!row) throw debugError("Job not found", 404);
    return summary(row);
  }
  return {
    listJobs({ cursor, limit } = {}) {
      const count = limitValue(limit, 50, 50),
        after = decode(cursor, "jobs");
      if (
        after &&
        (typeof after.createdAt !== "string" ||
          after.createdAt.length > 64 ||
          !uuid.test(after.jobId))
      )
        throw debugError("Invalid cursor");
      return read((db) => {
        const rows = db
          .prepare(
            `SELECT ${jobColumns} FROM jobs ${after ? "WHERE (created_at,job_id) < (?,?)" : ""} ORDER BY created_at DESC,job_id DESC LIMIT ?`,
          )
          .all(...(after ? [after.createdAt, after.jobId] : []), count + 1);
        const jobs = rows.slice(0, count).map(summary),
          last = jobs.at(-1);
        return {
          source: text(sourceLabel, 80),
          jobs,
          nextCursor:
            rows.length > count
              ? encode({
                  kind: "jobs",
                  createdAt: last.createdAt,
                  jobId: last.jobId,
                })
              : null,
        };
      });
    },
    getJob(id) {
      return read((db) => {
        const job = requireJob(db, id);
        const available = [
          "event_subscriptions",
          "event_deliveries",
          "event_outbox",
        ].every((name) => hasTable(db, name));
        let subscriptions = [];
        if (available)
          subscriptions = db
            .prepare(
              `SELECT s.event_name,s.state,s.expires_at,
          EXISTS(SELECT 1 FROM event_deliveries d WHERE d.subscription_id=s.id AND (d.status='stopped' OR (d.status='pending' AND d.attempts>0))) AS degraded
          FROM event_subscriptions s WHERE s.job_id=? LIMIT 100`,
            )
            .all(id)
            .map((s) => ({
              name: safeChoice(s.event_name, eventNames),
              state:
                s.expires_at <= Date.now()
                  ? "expired"
                  : safeChoice(s.state, [
                      "active",
                      "verifying",
                      "stopped",
                      "failed",
                      "cancelled",
                    ]),
              degraded: !!s.degraded,
            }));
        return {
          source: text(sourceLabel, 80),
          job,
          notification: {
            available,
            subscriptions,
            delivery: !available
              ? "unavailable"
              : !subscriptions.length
                ? "not_subscribed"
                : subscriptions.some((s) => s.degraded)
                  ? "degraded"
                  : subscriptions.some((s) => s.state === "active")
                    ? "active"
                    : "stopped",
          },
        };
      });
    },
    async events(id, { cursor, limit } = {}) {
      read((db) => requireJob(db, id));
      const count = limitValue(limit),
        after = decode(cursor, "events");
      if (
        after &&
        (after.jobId !== id ||
          !Number.isSafeInteger(after.offset) ||
          after.offset < 0 ||
          typeof after.file !== "string")
      )
        throw debugError("Invalid cursor");
      let file;
      try {
        const root = await realpath(diagnosticsRoot),
          path = join(root, id, "pipeline.jsonl");
        const resolved = await realpath(path),
          rel = relative(root, resolved);
        if (rel.startsWith(".." + sep) || rel === ".." || resolved !== path)
          throw debugError("Unsafe diagnostic file", 403);
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await file.stat();
        if (!stat.isFile()) throw debugError("Unsafe diagnostic file", 403);
        const identity = `${stat.dev}:${stat.ino}`;
        const reset =
          !!after && (after.file !== identity || after.offset > stat.size);
        const start = reset ? 0 : (after?.offset ?? 0);
        const buffer = Buffer.alloc(Math.min(1024 * 1024, stat.size - start));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
        const data = buffer.subarray(0, bytesRead),
          events = [];
        let pos = 0,
          malformed = 0;
        while (pos < data.length && events.length < count) {
          const end = data.indexOf(10, pos);
          if (end < 0) break;
          const line = data.subarray(pos, end),
            offset = start + pos;
          pos = end + 1;
          if (!line.toString("utf8").trim()) continue;
          if (line.length > 65536) {
            malformed++;
            continue;
          }
          const raw = parse(line.toString("utf8"));
          const normalized = normalizePipelineEvent(raw, raw?.timestamp);
          if (!normalized) {
            malformed++;
            continue;
          }
          if (normalized.jobId !== id || normalized.runId !== id) continue;
          events.push({ ...normalized, id: `${id}:${identity}:${offset}` });
        }
        // Never silently loop on an oversized single record that exceeds the read budget.
        if (pos === 0 && bytesRead === 1024 * 1024)
          throw debugError("Diagnostic record exceeds read limit", 422);
        const next = encode({
          kind: "events",
          jobId: id,
          file: identity,
          offset: start + pos,
        });
        const completeRemaining =
          data.indexOf(10, pos) >= 0 || start + bytesRead < stat.size;
        return {
          events,
          cursor: next,
          nextCursor: completeRemaining ? next : null,
          availability: "available",
          malformed,
          incompleteLine: !completeRemaining && pos < data.length,
          reset,
          bytesRead,
        };
      } catch (error) {
        if (error.code === "ENOENT")
          return {
            events: [],
            cursor: null,
            nextCursor: null,
            availability: "missing",
            malformed: 0,
            incompleteLine: false,
            reset: false,
          };
        if (error.status) throw error;
        throw debugError("Diagnostic log unavailable", 503);
      } finally {
        await file?.close();
      }
    },
    deliveries(id, { cursor, limit } = {}) {
      const count = limitValue(limit),
        after = decode(cursor, "deliveries");
      if (
        after &&
        (after.jobId !== id ||
          !Number.isSafeInteger(after.sequence) ||
          after.sequence < 0 ||
          typeof after.id !== "string" ||
          after.id.length > 300)
      )
        throw debugError("Invalid cursor");
      return read((db) => {
        requireJob(db, id);
        if (
          !["event_outbox", "event_deliveries", "event_subscriptions"].every(
            (n) => hasTable(db, n),
          )
        )
          return {
            available: false,
            deliveries: [],
            nextCursor: null,
            attemptHistoryAvailable: false,
          };
        const rows = db
          .prepare(
            `SELECT d.id,d.status,d.attempts,d.last_code,d.http_status,d.acked_at,e.sequence,e.event_name,e.timestamp
          FROM event_deliveries d JOIN event_outbox e ON e.event_id=d.event_id JOIN event_subscriptions s ON s.id=d.subscription_id
          WHERE e.job_id=? AND s.job_id=? ${after ? "AND (e.sequence,d.id) > (?,?)" : ""}
          ORDER BY e.sequence,d.id LIMIT ?`,
          )
          .all(id, id, ...(after ? [after.sequence, after.id] : []), count + 1);
        const deliveries = rows.slice(0, count).map((r) => ({
          id: r.id,
          sequence: r.sequence,
          name: safeChoice(r.event_name, eventNames),
          timestamp: r.timestamp,
          status: safeChoice(r.status, [
            "pending",
            "claimed",
            "acked",
            "stopped",
          ]),
          attempts: r.attempts,
          lastCode: deliveryCodes.has(r.last_code) ? r.last_code : null,
          httpStatus: r.http_status,
          ackedAt: iso(r.acked_at),
        }));
        const last = deliveries.at(-1);
        return {
          available: true,
          deliveries,
          nextCursor:
            rows.length > count
              ? encode({
                  kind: "deliveries",
                  jobId: id,
                  sequence: last.sequence,
                  id: last.id,
                })
              : null,
          attemptHistoryAvailable: false,
        };
      });
    },
  };
}
