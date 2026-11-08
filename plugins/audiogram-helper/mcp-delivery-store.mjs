import { randomUUID } from "node:crypto";
import { requireEventPrincipal, eventError } from "./mcp-events.mjs";

const delays = [5000, 10000, 20000, 40000, 80000, 160000, 300000];
const safeCodes = new Set([
  "timeout",
  "network_error",
  "unsafe_destination",
  "response_too_large",
  "invalid_event",
  "secret_unavailable",
  "ARTIFACT_UNAVAILABLE",
  "delivery_failed",
]);
function retryAfterMs(value, now) {
  if (typeof value !== "string") return 0;
  const delay = /^\d+$/.test(value.trim())
    ? Number(value) * 1000
    : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, Math.min(300000, delay)) : 0;
}
export function createDeliveryStore({ db, getJob, transaction, decodeEvent }) {
  const current = ({ id, claimToken, now }) =>
    db
      .prepare(
        `SELECT d.*,s.owner_id,s.job_id,s.event_name,s.callback_url,s.secret_box,
    s.previous_secret_box,s.previous_expires_at,s.version,s.expires_at,e.envelope_json
    FROM event_deliveries d JOIN event_subscriptions s ON s.id=d.subscription_id
    JOIN jobs j ON j.job_id=s.job_id AND j.owner_id=s.owner_id JOIN event_outbox e ON e.event_id=d.event_id
    WHERE d.id=? AND d.claim_token=? AND d.status='claimed' AND d.lease_until>?
    AND s.state='active' AND s.expires_at>? AND s.version=d.subscription_version`,
      )
      .get(id, claimToken, now, now);
  return {
    claimDueDeliveries({ now = Date.now(), limit = 20, leaseMs = 60000 } = {}) {
      if (
        !Number.isFinite(now) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 20 ||
        !Number.isInteger(leaseMs) ||
        leaseMs < 1 ||
        leaseMs > 60000
      )
        throw new Error("Invalid delivery claim policy.");
      return transaction(() => {
        db.prepare(
          `UPDATE event_deliveries SET status='stopped',claim_token=NULL,lease_until=NULL,last_code='attempts_exhausted'
          WHERE status='claimed' AND lease_until<=? AND attempts>=8`,
        ).run(now);
        const rows = db
          .prepare(
            `SELECT d.id,s.version FROM event_deliveries d
          JOIN event_subscriptions s ON s.id=d.subscription_id JOIN jobs j ON j.job_id=s.job_id AND j.owner_id=s.owner_id
          WHERE s.state='active' AND s.expires_at>? AND d.attempts<8
          AND ((d.status='pending' AND d.next_attempt_at<=?) OR (d.status='claimed' AND d.lease_until<=?))
          AND NOT EXISTS(SELECT 1 FROM event_deliveries earlier WHERE earlier.subscription_id=d.subscription_id
            AND earlier.sequence<d.sequence AND earlier.status<>'acked')
          AND NOT EXISTS(SELECT 1 FROM event_deliveries active WHERE active.subscription_id=d.subscription_id
            AND active.status='claimed' AND active.lease_until>?)
          ORDER BY d.next_attempt_at,d.sequence,d.id LIMIT ?`,
          )
          .all(now, now, now, now, limit);
        return rows.map((row) => {
          const claimToken = randomUUID();
          db.prepare(
            `UPDATE event_deliveries SET status='claimed',claim_token=?,lease_until=?,attempts=attempts+1,subscription_version=? WHERE id=?`,
          ).run(claimToken, now + leaseMs, row.version, row.id);
          return { id: row.id, claimToken };
        });
      });
    },
    getDeliveryContext(input) {
      const row = current(input);
      return row
        ? {
            id: row.id,
            event: decodeEvent(row),
            subscription: {
              id: row.subscription_id,
              ownerId: row.owner_id,
              jobId: row.job_id,
              name: row.event_name,
              url: row.callback_url,
              sealedSecret: row.secret_box,
              previousSealedSecret:
                row.previous_expires_at > input.now
                  ? row.previous_secret_box
                  : null,
            },
          }
        : null;
    },
    acknowledgeDelivery(input) {
      return transaction(() => {
        const row = current(input);
        if (!row) return false;
        db.prepare(
          `UPDATE event_deliveries SET status='acked',acked_at=?,claim_token=NULL,lease_until=NULL,last_code=NULL,http_status=200 WHERE id=?`,
        ).run(input.now, row.id);
        db.prepare(
          "UPDATE event_subscriptions SET acked_sequence=MAX(acked_sequence,?) WHERE id=?",
        ).run(row.sequence, row.subscription_id);
        return true;
      });
    },
    failDelivery({
      id,
      claimToken,
      now,
      code = "delivery_failed",
      httpStatus,
      retryAfter,
      random = () => 0,
    }) {
      return transaction(() => {
        const row = current({ id, claimToken, now });
        if (!row) return false;
        const status =
          Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
            ? httpStatus
            : null;
        const safeCode = safeCodes.has(code) ? code : "delivery_failed";
        const retryable =
          ![
            "unsafe_destination",
            "invalid_event",
            "secret_unavailable",
            "ARTIFACT_UNAVAILABLE",
          ].includes(safeCode) &&
          (status === null ||
            status === 408 ||
            status === 429 ||
            status >= 500);
        const stopped = !retryable || row.attempts >= 8;
        const base = delays[Math.min(row.attempts - 1, delays.length - 1)];
        const jitter = Math.max(0, Math.min(1, Number(random()) || 0));
        const wait = Math.max(
          base + Math.floor(base * 0.2 * jitter),
          [429, 503].includes(status) ? retryAfterMs(retryAfter, now) : 0,
        );
        db.prepare(
          `UPDATE event_deliveries SET status=?,next_attempt_at=?,claim_token=NULL,lease_until=NULL,last_code=?,http_status=? WHERE id=?`,
        ).run(
          stopped ? "stopped" : "pending",
          now + wait,
          safeCode,
          status,
          id,
        );
        return true;
      });
    },
    releaseDelivery({ id, claimToken }) {
      return (
        Number(
          db
            .prepare(
              `UPDATE event_deliveries SET status='pending',claim_token=NULL,lease_until=NULL
        WHERE id=? AND claim_token=? AND status='claimed'`,
            )
            .run(id, claimToken).changes,
        ) === 1
      );
    },
    getNotificationHealth(
      jobId,
      { principal, subscriptionId, now = Date.now() } = {},
    ) {
      const job = getJob(jobId);
      if (!job || job.ownerId !== requireEventPrincipal(principal))
        throw eventError(-32001, "Job access denied.");
      const rows = db
        .prepare(
          `SELECT s.id,s.event_name,s.state,s.expires_at,
        EXISTS(SELECT 1 FROM event_deliveries d WHERE d.subscription_id=s.id AND d.status='stopped') AS stopped,
        EXISTS(SELECT 1 FROM event_deliveries d WHERE d.subscription_id=s.id AND (d.status='stopped' OR (d.status='pending' AND d.attempts>0))) AS degraded
        FROM event_subscriptions s WHERE s.job_id=? AND s.owner_id=?`,
        )
        .all(jobId, principal.id);
      const active = rows.filter(
        (row) => row.state === "active" && row.expires_at > now,
      );
      const selected =
        subscriptionId === undefined
          ? rows
          : rows.filter((row) => row.id === subscriptionId);
      if (subscriptionId !== undefined && !selected.length)
        throw eventError(-32001, "Subscription access denied.");
      return {
        capture: job.captureHealth,
        subscriptions: selected
          .slice(0, 50)
          .map((row) => ({
            id: row.id,
            name: row.event_name,
            state:
              row.state === "active" && row.expires_at <= now
                ? "expired"
                : row.state,
          })),
        delivery: !rows.length
          ? "not_subscribed"
          : !active.length || active.every((row) => row.stopped)
            ? "stopped"
            : active.some((row) => row.degraded)
              ? "degraded"
              : "active",
      };
    },
  };
}
