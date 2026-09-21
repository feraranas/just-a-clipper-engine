import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { sanitizeErrorDiagnostic } from "./error-diagnostics.mjs";

const states = [
  "queued",
  "approved",
  "rejected",
  "uploading",
  "container_created",
  "processing",
  "published",
  "failed",
  "unknown",
];

const transitions = new Map([
  ["queued", new Set(["approved", "rejected"])],
  ["approved", new Set(["uploading", "rejected", "failed"])],
  ["uploading", new Set(["container_created", "failed", "unknown"])],
  ["container_created", new Set(["processing", "failed", "unknown"])],
  ["processing", new Set(["published", "failed", "unknown"])],
  ["published", new Set()],
  ["rejected", new Set()],
  ["failed", new Set(["approved"])],
  ["unknown", new Set()],
]);

const mapItem = (row) =>
  row
    ? {
        id: row.id,
        artifactRelativePath: row.artifact_relative_path,
        artifactHash: row.artifact_hash,
        approvedArtifactHash: row.approved_artifact_hash,
        sourceVideoId: row.source_video_id,
        clipPackageId: row.clip_package_id,
        treatmentId: row.treatment_id,
        treatmentVersion: row.treatment_version,
        title: row.title,
        caption: row.caption,
        accountId: row.account_id,
        state: row.state,
        approvalDecision: row.approval_decision,
        scheduledAt: row.scheduled_at,
        approvedAt: row.approved_at,
        rejectedAt: row.rejected_at,
        rejectionReason: row.rejection_reason,
        mediaHostKey: row.media_host_key,
        mediaHostUrl: row.media_host_url,
        containerId: row.container_id,
        mediaId: row.media_id,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        retryCount: row.retry_count,
        lastRetryAt: row.last_retry_at,
        publishedAt: row.published_at,
        unknownDetails: row.unknown_details_json
          ? JSON.parse(row.unknown_details_json)
          : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

const requiredText = (value, name) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
};

const optionalText = (value) => (value == null ? null : String(value));

const createSchema = (database) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS publishing_items (
      id TEXT PRIMARY KEY,
      artifact_relative_path TEXT NOT NULL,
      artifact_hash TEXT NOT NULL,
      approved_artifact_hash TEXT,
      source_video_id TEXT,
      clip_package_id INTEGER,
      treatment_id TEXT,
      treatment_version TEXT,
      title TEXT NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
      account_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued', 'approved', 'rejected', 'uploading',
                         'container_created', 'processing', 'published',
                         'failed', 'unknown')),
      approval_decision TEXT
        CHECK (approval_decision IN ('approved', 'rejected') OR approval_decision IS NULL),
      scheduled_at TEXT,
      approved_at TEXT,
      rejected_at TEXT,
      rejection_reason TEXT,
      media_host_key TEXT,
      media_host_url TEXT,
      container_id TEXT,
      media_id TEXT,
      error_code TEXT,
      error_message TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
      last_retry_at TEXT,
      published_at TEXT,
      unknown_details_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (artifact_relative_path, artifact_hash)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS publishing_items_state_idx
      ON publishing_items(state, scheduled_at, created_at);
    CREATE INDEX IF NOT EXISTS publishing_items_account_idx
      ON publishing_items(account_id, state);
  `);
};

const normalizePatch = (patch = {}) => {
  const allowed = new Set([
    "artifactHash",
    "mediaHostKey",
    "mediaHostUrl",
    "containerId",
    "mediaId",
    "errorCode",
    "errorMessage",
    "retryCount",
    "lastRetryAt",
    "publishedAt",
    "unknownDetails",
  ]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new Error(`Unsupported transition patch: ${key}`);
  }
  return {
    artifact_hash: patch.artifactHash,
    media_host_key: patch.mediaHostKey,
    media_host_url: patch.mediaHostUrl,
    container_id: patch.containerId,
    media_id: patch.mediaId,
    error_code: patch.errorCode,
    error_message:
      patch.errorMessage == null
        ? patch.errorMessage
        : sanitizeErrorDiagnostic(patch.errorMessage),
    retry_count: patch.retryCount,
    last_retry_at: patch.lastRetryAt,
    published_at: patch.publishedAt,
    unknown_details_json:
      patch.unknownDetails == null
        ? patch.unknownDetails
        : JSON.stringify(patch.unknownDetails),
  };
};

export const createPublishingLedger = (
  dbPath,
  { now = () => new Date().toISOString() } = {},
) => {
  const database = new DatabaseSync(dbPath, { timeout: 5_000 });
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  createSchema(database);

  const getRow = (id) =>
    database.prepare("SELECT * FROM publishing_items WHERE id = ?").get(id);
  const getItem = (id) => mapItem(getRow(id));
  const withImmediateTransaction = (operation) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const transition = (id, fromState, toState, patch = {}) =>
    withImmediateTransaction(() => {
      const row = getRow(id);
      if (!row) throw new Error(`Publishing item not found: ${id}`);
      if (row.state !== fromState) {
        throw new Error(
          `Expected item ${id} to be ${fromState}, but it is ${row.state}`,
        );
      }
      if (!states.includes(toState) || !transitions.get(fromState).has(toState)) {
        throw new Error(`Invalid transition: ${fromState} -> ${toState}`);
      }

      const normalized = normalizePatch(patch);
      if (
        normalized.artifact_hash != null &&
        row.approved_artifact_hash != null &&
        normalized.artifact_hash !== row.approved_artifact_hash
      ) {
        throw new Error(
          `Artifact hash mismatch: expected ${row.approved_artifact_hash}, got ${normalized.artifact_hash}`,
        );
      }

      const assignments = ["state = ?", "updated_at = ?"];
      const values = [toState, now()];
      for (const [column, value] of Object.entries(normalized)) {
        if (value !== undefined) {
          assignments.push(`${column} = ?`);
          values.push(value);
        }
      }
      if (toState === "published" && normalized.published_at === undefined) {
        assignments.push("published_at = ?");
        values.push(now());
      }
      values.push(id);
      database
        .prepare(`UPDATE publishing_items SET ${assignments.join(", ")} WHERE id = ?`)
        .run(...values);
      return getItem(id);
    });

  return {
    close: () => database.close(),
    enqueueArtifact: (input) => {
      const artifactRelativePath = requiredText(
        input.artifactRelativePath,
        "artifactRelativePath",
      );
      const artifactHash = requiredText(input.artifactHash, "artifactHash");
      const title = requiredText(input.title, "title");
      const accountId = requiredText(input.accountId, "accountId");
      const timestamp = now();
      const id = input.id ?? randomUUID();
      database
        .prepare(`
          INSERT INTO publishing_items (
            id, artifact_relative_path, artifact_hash, source_video_id,
            clip_package_id, treatment_id, treatment_version, title, caption,
            account_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(artifact_relative_path, artifact_hash) DO NOTHING
        `)
        .run(
          id,
          artifactRelativePath,
          artifactHash,
          optionalText(input.sourceVideoId),
          input.clipPackageId ?? null,
          optionalText(input.treatmentId),
          optionalText(input.treatmentVersion),
          title,
          input.caption == null ? "" : String(input.caption),
          accountId,
          timestamp,
          timestamp,
        );
      return getItem(
        database
          .prepare(
            "SELECT id FROM publishing_items WHERE artifact_relative_path = ? AND artifact_hash = ?",
          )
          .get(artifactRelativePath, artifactHash).id,
      );
    },
    getQueue: (filters = {}) => {
      const clauses = [];
      const values = [];
      if (filters.state) {
        clauses.push("state = ?");
        values.push(filters.state);
      }
      if (filters.states) {
        if (!Array.isArray(filters.states) || filters.states.length === 0) {
          throw new Error("states filter must be a non-empty array");
        }
        clauses.push(`state IN (${filters.states.map(() => "?").join(", ")})`);
        values.push(...filters.states);
      }
      if (filters.accountId) {
        clauses.push("account_id = ?");
        values.push(filters.accountId);
      }
      if (filters.scheduledBefore) {
        clauses.push("scheduled_at IS NOT NULL AND scheduled_at <= ?");
        values.push(filters.scheduledBefore);
      }
      const limit = filters.limit == null ? "" : " LIMIT ?";
      if (filters.limit != null) values.push(filters.limit);
      return database
        .prepare(
          `SELECT * FROM publishing_items ${
            clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
          } ORDER BY created_at, id${limit}`,
        )
        .all(...values)
        .map(mapItem);
    },
    getPublishingItem: getItem,
    updateCaption: (id, caption) => {
      const value = String(caption);
      if (value.trim() === "") throw new Error("caption must not be empty");
      const item = getItem(id);
      if (!item) throw new Error(`Publishing item not found: ${id}`);
      if (!["queued", "approved"].includes(item.state)) {
        throw new Error(`Cannot update caption in state: ${item.state}`);
      }
      database
        .prepare(
          "UPDATE publishing_items SET caption = ?, updated_at = ? WHERE id = ?",
        )
        .run(value, now(), id);
      return getItem(id);
    },
    approveItem: (id, scheduledAt) => {
      const item = getItem(id);
      if (!item) throw new Error(`Publishing item not found: ${id}`);
      if (item.state !== "queued") {
        throw new Error(`Cannot approve item in state: ${item.state}`);
      }
      requiredText(scheduledAt, "scheduledAt");
      return withImmediateTransaction(() => {
        const timestamp = now();
        database
          .prepare(`
            UPDATE publishing_items
            SET state = 'approved', approval_decision = 'approved',
                scheduled_at = ?, approved_at = ?,
                approved_artifact_hash = artifact_hash, updated_at = ?
            WHERE id = ? AND state = 'queued'
          `)
          .run(scheduledAt, timestamp, timestamp, id);
        return getItem(id);
      });
    },
    rejectItem: (id, reason) => {
      const value = requiredText(reason, "reason");
      const item = getItem(id);
      if (!item) throw new Error(`Publishing item not found: ${id}`);
      if (!["queued", "approved"].includes(item.state)) {
        throw new Error(`Cannot reject item in state: ${item.state}`);
      }
      return withImmediateTransaction(() => {
        database
          .prepare(`
            UPDATE publishing_items
            SET state = 'rejected', approval_decision = 'rejected',
                rejection_reason = ?, rejected_at = ?, updated_at = ?
            WHERE id = ?
          `)
          .run(value, now(), now(), id);
        return getItem(id);
      });
    },
    claimDueApprovedItem: (at) =>
      withImmediateTransaction(() => {
        const row = database
          .prepare(`
            SELECT id FROM publishing_items
            WHERE state = 'approved' AND scheduled_at IS NOT NULL
              AND scheduled_at <= ?
            ORDER BY scheduled_at, created_at, id
            LIMIT 1
          `)
          .get(at);
        if (!row) return null;
        database
          .prepare(
            "UPDATE publishing_items SET state = 'uploading', updated_at = ?, last_retry_at = ?, retry_count = retry_count + 1 WHERE id = ? AND state = 'approved'",
          )
          .run(now(), now(), row.id);
        return getItem(row.id);
      }),
    transitionItem: transition,
    recordUnknownOutcome: (id, details) => {
      const item = getItem(id);
      if (!item) throw new Error(`Publishing item not found: ${id}`);
      if (!["uploading", "container_created", "processing"].includes(item.state)) {
        throw new Error(`Cannot record unknown outcome in state: ${item.state}`);
      }
      return transition(id, item.state, "unknown", {
        ...details,
        unknownDetails: details,
      });
    },
  };
};
