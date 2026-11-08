import { setTimeout as wait } from "node:timers/promises";
import { toWebhookEnvelope } from "./mcp-event-contract.mjs";

export async function dispatcherTick({
  store,
  webhook,
  secrets,
  clock = Date.now,
  random = Math.random,
  signal,
  validateResult,
}) {
  const summary = { claimed: 0, sent: 0, acknowledged: 0, failed: 0 };
  if (signal?.aborted) return summary;
  store.reconcileDeliveries({ now: clock() });
  const claims = store.claimDueDeliveries({
    now: clock(),
    limit: 20,
    leaseMs: 60000,
  });
  summary.claimed = claims.length;
  let index = 0;
  const send = async (claim) => {
    if (signal?.aborted) {
      store.releaseDelivery(claim);
      return;
    }
    let context = store.getDeliveryContext({ ...claim, now: clock() });
    if (!context) {
      store.releaseDelivery(claim);
      return;
    }
    try {
      if (
        context.event.name === "audiogram.job.finished" &&
        ["complete", "partial"].includes(context.event.data.status)
      ) {
        const job = store.getJob(context.subscription.jobId);
        try {
          if (typeof validateResult !== "function") throw new Error();
          await validateResult(job.result, job);
        } catch {
          throw Object.assign(new Error("Media unavailable."), {
            reason: "ARTIFACT_UNAVAILABLE",
          });
        }
      }
      context = store.getDeliveryContext({ ...claim, now: clock() });
      if (!context || signal?.aborted) {
        store.releaseDelivery(claim);
        return;
      }
      let subscription;
      try {
        subscription = {
          ...context.subscription,
          secret: secrets.openSecret(context.subscription.sealedSecret),
          ...(context.subscription.previousSealedSecret
            ? {
                previousSecret: secrets.openSecret(
                  context.subscription.previousSealedSecret,
                ),
              }
            : {}),
        };
      } catch {
        throw Object.assign(new Error("Secret unavailable."), {
          reason: "secret_unavailable",
        });
      }
      const cursor = secrets.encodeCursor({
        principalId: subscription.ownerId,
        jobId: subscription.jobId,
        name: subscription.name,
        sequence: context.event.data.sequence,
      });
      const event = toWebhookEnvelope(context.event, { cursor });
      summary.sent++;
      const response = await webhook.sendSignedEvent({
        subscription,
        event,
        signal,
      });
      if (response.accepted) {
        if (store.acknowledgeDelivery({ ...claim, now: clock() }))
          summary.acknowledged++;
        else store.releaseDelivery(claim);
      } else {
        if (
          store.failDelivery({
            ...claim,
            now: clock(),
            code: "delivery_failed",
            httpStatus: response.httpStatus,
            retryAfter: response.retryAfter,
            random,
          })
        )
          summary.failed++;
        else store.releaseDelivery(claim);
      }
    } catch (error) {
      if (signal?.aborted) {
        store.releaseDelivery(claim);
        return;
      }
      if (
        store.failDelivery({
          ...claim,
          now: clock(),
          code: error.reason ?? "network_error",
          random,
        })
      )
        summary.failed++;
      else store.releaseDelivery(claim);
    }
  };
  const sends = await Promise.allSettled(
    Array.from({ length: Math.min(4, claims.length) }, async () => {
      while (index < claims.length) {
        const claim = claims[index++];
        await send(claim);
      }
    }),
  );
  // One database failure must not orphan concurrent HTTP work. The service
  // awaits every send before retrying the tick or closing the shared store.
  const failed = sends.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return summary;
}

export function startEventDispatcher(options) {
  const controller = new AbortController();
  const sleep =
    options.sleep ?? ((ms, signal) => wait(ms, undefined, { signal }));
  let failures = 0;
  let nextPrune = 0;
  const done = (async () => {
    while (!controller.signal.aborted) {
      let pause = 1000;
      try {
        const result = await dispatcherTick({
          ...options,
          signal: controller.signal,
        });
        if ((options.clock ?? Date.now)() >= nextPrune) {
          options.store.pruneEventHistory({
            now: (options.clock ?? Date.now)(),
          });
          nextPrune = (options.clock ?? Date.now)() + 600000;
        }
        failures = 0;
        if (result.claimed > 0) pause = 0;
      } catch {
        failures++;
        pause = Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5));
        try {
          options.onHealth?.({ code: "EVENT_DISPATCHER_DEGRADED" });
        } catch {
          /* Safe summaries only. */
        }
      }
      if (controller.signal.aborted) break;
      try {
        await sleep(pause, controller.signal);
      } catch {
        if (controller.signal.aborted) break;
      }
    }
  })();
  return Object.freeze({
    done,
    stop: () => {
      controller.abort(new Error("Dispatcher stopped."));
      return done;
    },
  });
}
