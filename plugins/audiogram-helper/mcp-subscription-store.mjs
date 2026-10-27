import { createHash } from "node:crypto";
import { validateWebhookSecret } from "./mcp-event-secrets.mjs";
import { validateCallbackUrl } from "./mcp-webhook.mjs";
import { eventError, requireEventPrincipal } from "./mcp-events.mjs";

export function migrateEventSubscriptions(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_subscriptions (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(job_id),
      event_name TEXT NOT NULL, callback_url TEXT NOT NULL, state TEXT NOT NULL,
      version INTEGER NOT NULL, expires_at INTEGER NOT NULL, verified_until INTEGER NOT NULL DEFAULT 0,
      secret_box TEXT, secret_fingerprint TEXT, candidate_secret_box TEXT, candidate_fingerprint TEXT,
      previous_secret_box TEXT, previous_expires_at INTEGER,
      acked_sequence INTEGER NOT NULL DEFAULT 0, replay_after INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS event_deliveries (
      id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id),
      event_id TEXT NOT NULL REFERENCES event_outbox(event_id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL, lease_until INTEGER, claim_token TEXT, subscription_version INTEGER,
      last_code TEXT, http_status INTEGER, acked_at INTEGER, UNIQUE(subscription_id,event_id)
    );
    CREATE INDEX IF NOT EXISTS deliveries_due ON event_deliveries(status,next_attempt_at);
    CREATE INDEX IF NOT EXISTS deliveries_stream ON event_deliveries(subscription_id,sequence);
    CREATE TABLE IF NOT EXISTS event_stream_floors (
      job_id TEXT NOT NULL REFERENCES jobs(job_id), event_name TEXT NOT NULL, deletion_floor INTEGER NOT NULL,
      PRIMARY KEY(job_id,event_name)
    );
    INSERT OR IGNORE INTO mcp_event_schema(version) VALUES(2);
  `);
}

// Works inside the caller's existing transaction: activation/reconciliation and append cannot lose a fact.
export function enqueueEventDeliveries(
  db,
  now,
  { eventId, subscriptionId } = {},
) {
  db.prepare(
    `INSERT OR IGNORE INTO event_deliveries(id,subscription_id,event_id,sequence,next_attempt_at)
    SELECT s.id||':'||e.event_id,s.id,e.event_id,e.sequence,?
    FROM event_subscriptions s JOIN jobs j ON j.job_id=s.job_id AND j.owner_id=s.owner_id
    JOIN event_outbox e ON e.job_id=s.job_id AND e.event_name=s.event_name AND e.sequence>s.replay_after
    WHERE s.state='active' AND s.expires_at>? ${eventId ? "AND e.event_id=?" : ""} ${subscriptionId ? "AND s.id=?" : ""}`,
  ).run(
    now,
    now,
    ...(eventId ? [eventId] : []),
    ...(subscriptionId ? [subscriptionId] : []),
  );
}

export function createSubscriptionStore({
  db,
  getJob,
  transaction,
  canonicalJson,
  finalizeJob,
}) {
  const authorized = (principal, jobId) => {
    const ownerId = requireEventPrincipal(principal);
    const job = getJob(jobId);
    if (!job || job.ownerId !== ownerId)
      throw eventError(-32001, "Job access denied.");
    return job;
  };
  const identity = (ownerId, name, args, url) =>
    `sub_${createHash("sha256")
      .update(canonicalJson({ ownerId, name, args, url }))
      .digest("hex")}`;
  const read = (id) =>
    db.prepare("SELECT * FROM event_subscriptions WHERE id=?").get(id);
  const floorFor = (jobId, name) =>
    db
      .prepare(
        "SELECT deletion_floor FROM event_stream_floors WHERE job_id=? AND event_name=?",
      )
      .get(jobId, name)?.deletion_floor ?? 0;
  return {
    async subscribe(
      { principal, name, arguments: args, delivery, ttlMs, cursor },
      { secrets, webhook, clock = Date.now, validateResult } = {},
    ) {
      const job = authorized(principal, args.job_id);
      let url;
      let fingerprint;
      try {
        url = validateCallbackUrl(delivery.url).toString();
        fingerprint = secrets.fingerprintSecret(
          validateWebhookSecret(delivery.secret),
        );
      } catch {
        throw eventError(-32602, "Invalid callback configuration.");
      }
      const now = clock();
      const ttl = ttlMs == null ? 86400000 : Math.min(ttlMs, 7 * 86400000);
      const id = identity(principal.id, name, args, url);
      const scope = { principalId: principal.id, jobId: job.jobId, name };
      let requested = 0;
      try {
        if (cursor != null)
          requested = secrets.decodeCursor(cursor, scope).sequence;
      } catch {
        throw eventError(-32602, "Invalid replay cursor.");
      }
      if (requested > job.lastEventSequence)
        throw eventError(-32602, "Invalid replay position.");
      const prepared = transaction(() => {
        authorized(principal, job.jobId);
        const prior = read(id);
        const version = (prior?.version ?? 0) + 1;
        const after = prior
          ? cursor == null
            ? prior.acked_sequence
            : Math.min(requested, prior.acked_sequence)
          : requested;
        const cache =
          prior?.secret_fingerprint === fingerprint &&
          prior.verified_until > now &&
          prior.secret_box;
        if (prior)
          db.prepare(
            `UPDATE event_subscriptions SET state='verifying',version=?,expires_at=?,candidate_secret_box=?,candidate_fingerprint=?,replay_after=?,updated_at=? WHERE id=?`,
          ).run(
            version,
            now + ttl,
            secrets.sealSecret(delivery.secret),
            fingerprint,
            after,
            now,
            id,
          );
        else
          db.prepare(
            `INSERT INTO event_subscriptions(id,owner_id,job_id,event_name,callback_url,state,version,expires_at,candidate_secret_box,candidate_fingerprint,replay_after,acked_sequence,created_at,updated_at)
          VALUES(?,?,?,?,?,'verifying',?,?,?,?,?,?,?,?)`,
          ).run(
            id,
            principal.id,
            job.jobId,
            name,
            url,
            version,
            now + ttl,
            secrets.sealSecret(delivery.secret),
            fingerprint,
            after,
            after,
            now,
            now,
          );
        return { version, after, cache: Boolean(cache) };
      });
      if (!prepared.cache) {
        try {
          await webhook.verifyCallback({
            url,
            secret: delivery.secret,
            subscriptionId: id,
          });
        } catch (error) {
          transaction(() =>
            db
              .prepare(
                `UPDATE event_subscriptions SET candidate_secret_box=NULL,candidate_fingerprint=NULL,state='rejected' WHERE id=? AND version=? AND state='verifying'`,
              )
              .run(id, prepared.version),
          );
          const reason = [
            "timeout",
            "challenge_failed",
            "unsafe_destination",
            "network_error",
            "response_too_large",
          ].includes(error.reason)
            ? error.reason
            : "challenge_failed";
          throw eventError(-32015, "Callback verification failed.", reason);
        }
      }
      // Artifact verification and legacy materialization are authorized and occur outside SQL/HTTP.
      const latest = authorized(principal, job.jobId);
      if (!["queued", "running"].includes(latest.status) && latest.result) {
        if (typeof validateResult !== "function")
          throw eventError(-32603, "Result verification is unavailable.");
        try {
          await validateResult(latest.result, latest);
        } catch {
          throw eventError(-32000, "Completed media is unavailable.");
        }
        if (!latest.finalizedAt)
          finalizeJob(latest.jobId, latest.result, { capture: "unknown" });
      }
      return transaction(() => {
        const currentJob = authorized(principal, job.jobId);
        const current = read(id);
        const activatedAt = clock();
        if (
          !current ||
          current.version !== prepared.version ||
          current.state !== "verifying" ||
          current.expires_at <= activatedAt
        )
          throw eventError(-32000, "Subscription changed before activation.");
        const rotating =
          current.secret_box && current.secret_fingerprint !== fingerprint;
        db.prepare(
          `UPDATE event_subscriptions SET state='active',secret_box=candidate_secret_box,secret_fingerprint=candidate_fingerprint,
          candidate_secret_box=NULL,candidate_fingerprint=NULL,previous_secret_box=?,previous_expires_at=?,verified_until=?,updated_at=? WHERE id=?`,
        ).run(
          rotating ? current.secret_box : current.previous_secret_box,
          rotating ? activatedAt + 300000 : current.previous_expires_at,
          prepared.cache ? current.verified_until : activatedAt + 300000,
          activatedAt,
          id,
        );
        db.prepare(
          `UPDATE event_deliveries SET status='pending',claim_token=NULL,lease_until=NULL,next_attempt_at=?
          WHERE subscription_id=? AND status='cancelled' AND sequence>?`,
        ).run(activatedAt, id, prepared.after);
        enqueueEventDeliveries(db, activatedAt, { subscriptionId: id });
        const floor = floorFor(job.jobId, name);
        return {
          id,
          refreshBefore: new Date(current.expires_at).toISOString(),
          cursor: secrets.encodeCursor({
            ...scope,
            sequence: current.acked_sequence,
          }),
          truncated: prepared.after < floor,
          currentStatus: { jobId: currentJob.jobId, status: currentJob.status },
        };
      });
    },
    unsubscribe(
      { principal, name, arguments: args, delivery },
      { clock = Date.now } = {},
    ) {
      authorized(principal, args.job_id);
      const url = validateCallbackUrl(delivery.url).toString();
      const id = identity(principal.id, name, args, url);
      return transaction(() => {
        db.prepare(
          `UPDATE event_subscriptions SET state='cancelled',version=version+1,secret_box=NULL,secret_fingerprint=NULL,
          candidate_secret_box=NULL,candidate_fingerprint=NULL,previous_secret_box=NULL,previous_expires_at=NULL,verified_until=0,updated_at=? WHERE id=?`,
        ).run(clock(), id);
        db.prepare(
          "UPDATE event_deliveries SET status='cancelled',claim_token=NULL,lease_until=NULL WHERE subscription_id=? AND status<>'acked'",
        ).run(id);
        return {};
      });
    },
    reconcileDeliveries({ now = Date.now() } = {}) {
      return transaction(() => {
        db.prepare(
          "UPDATE event_subscriptions SET previous_secret_box=NULL,previous_expires_at=NULL WHERE previous_expires_at<=?",
        ).run(now);
        enqueueEventDeliveries(db, now);
      });
    },
    pruneEventHistory({ now = Date.now() } = {}) {
      return transaction(() => {
        // Inactive subscriptions retain no keys after the overlap window.
        db.prepare(
          `UPDATE event_subscriptions SET secret_box=NULL,secret_fingerprint=NULL,candidate_secret_box=NULL,candidate_fingerprint=NULL,
          previous_secret_box=NULL,previous_expires_at=NULL,verified_until=0 WHERE expires_at<=? OR state='cancelled'`,
        ).run(now - 300000);
        const jobs = db
          .prepare(
            `SELECT j.job_id FROM jobs j WHERE j.finalized_at IS NOT NULL AND j.finalized_at<?
          AND NOT EXISTS(SELECT 1 FROM event_subscriptions s WHERE s.job_id=j.job_id AND s.state IN ('active','verifying') AND s.expires_at>?)
          AND NOT EXISTS(SELECT 1 FROM event_deliveries d JOIN event_subscriptions s ON s.id=d.subscription_id
            WHERE s.job_id=j.job_id AND s.state='active' AND s.expires_at>? AND d.status IN ('pending','claimed'))`,
          )
          .all(new Date(now - 30 * 86400000).toISOString(), now, now);
        let removed = 0;
        for (const { job_id: jobId } of jobs) {
          for (const row of db
            .prepare(
              "SELECT event_name,MAX(sequence) AS position FROM event_outbox WHERE job_id=? GROUP BY event_name",
            )
            .all(jobId)) {
            db.prepare(
              `INSERT INTO event_stream_floors(job_id,event_name,deletion_floor) VALUES(?,?,?)
              ON CONFLICT(job_id,event_name) DO UPDATE SET deletion_floor=MAX(deletion_floor,excluded.deletion_floor)`,
            ).run(jobId, row.event_name, row.position);
          }
          removed += Number(
            db.prepare("DELETE FROM event_outbox WHERE job_id=?").run(jobId)
              .changes,
          );
        }
        return { removed };
      });
    },
  };
}
