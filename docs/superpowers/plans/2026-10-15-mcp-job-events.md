# MCP Job Completion Events Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task, inline. The repository policy defaults to no subagents. Steps use checkboxes for tracking. This document authorizes no code execution or external publication by itself.

**Goal:** Notify a subscribed ChatGPT Work chat when a clip-generation attempt reaches a final outcome.

**Architecture:** The job store saves the final result and an immutable outbox event in one SQLite transaction. A long-running dispatcher claims separate delivery records, matches active subscriptions, and sends signed HTTPS webhooks. The worker does not make webhook requests.

**Tech Stack:** Node.js 22.13.0+, SQLite WAL, Zod, MCP 2.0 protocol `2026-07-28`, and Standard Webhooks signing. Existing SDK: `@modelcontextprotocol/sdk@1.29.0`; evaluate the documented `@modelcontextprotocol/server@2.3.1` migration in PR 1 and pin compatible released Node/client packages in the lockfile.

**Spec:** `docs/features/mcp-job-events.md` (review draft), consolidated from the discussion and `/Users/kiwi/Documents/Codex/audiograms-mcp-events-design-notes.md`.

## Global Constraints

- Five PRs, in the order below. Open/register PR 1 before beginning PR 2.
- These are sequence labels, not assigned GitHub PR numbers.
- One event name: `audiogram.job.finished`.
- Terminal statuses: `complete`, `partial`, `failed`, `no_clips`.
- A retry is a new attempt, not another terminal event for the original attempt.
- Preserve existing create/status/retry contracts, local rendering, and explicit retry approval.
- Local first; no cloud deployment or Instagram notification implementation.
- All callback secrets stay out of Git, logs, CLI arguments, and tool results.
- The event feature is off until the complete required protocol surface works.
- A successful webhook response confirms receipt, not that ChatGPT has answered.
- Delivery is at least once; do not promise exactly-once receipt or response.
- Review the spec and this plan before implementation. Do not change the active unrelated branch or its untracked files.

## Review Focus

1. Very fast completion: a subscription created after completion still receives the terminal event (PR 5).
2. Multiple subscribers and dispatchers: no cross-user leak; one failed destination does not block others (PR 4).
3. Crash after receipt but before acknowledgment persistence: same event may be resent, without rerunning processing (PR 4/5).
4. Missing, corrupt, or superseded worker results: every finalization path records a safe event or rolls back (PR 3).
5. DNS rebinding, redirects, and secret rotation: callback safety is enforced at connection time and renewal does not duplicate subscriptions (PR 4/5).

## Repository baseline and isolation

Observed on 2026-10-15: the current checkout is on `codex/template-sample-server`
with unrelated tracked/untracked work, including `scripts/dispatcher.mjs`.
Do not reuse or overwrite that dispatcher. The current MCP helper has no
event outbox, subscription handlers, or event dispatcher.

Existing owners:

| File | Responsibility |
| --- | --- |
| `plugins/audiogram-helper/server.mjs` | HTTP `/mcp`, tool schemas, request handling |
| `plugins/audiogram-helper/local-runner.mjs` | Attempt creation, worker dispatch, stale-worker failure |
| `plugins/audiogram-helper/job-worker.mjs` | CLI execution and terminal result writes |
| `plugins/audiogram-helper/job-store.mjs` | SQLite jobs table and mutations |
| `plugins/audiogram-helper/job-diagnostics.mjs` | Safe per-job diagnostics |
| `scripts/audiogram-url.mjs` | CLI boundary |
| `scripts/single-url-pipeline.mjs` | Clip-generation orchestration |

- [ ] Before implementation, verify physical checkout/root and current main; use a clean isolated worktree through native worktree tools.
- [ ] Use one `codex/` branch per PR; if dependent PRs are stacked, state the dependency and correct base explicitly.
- [ ] Preserve user `.env`, existing job records, credential files, and unrelated work.
- [ ] Snapshot the SDK package/version decision and protocol test results in PR 1; do not infer support from a version number alone.

## Data model and boundaries

Keep these four tables in the same MCP jobs database:

| Table | Stored data |
| --- | --- |
| `jobs` | Existing attempt identity, status, result, error, retry link; add owner identity |
| `event_outbox` | Immutable event ID, job ID, name, canonical payload JSON, occurrence time |
| `event_subscriptions` | Identity, owner, job filter, callback, secret/version, verification, expiry, active/cancelled state |
| `event_deliveries` | Event/subscription pair, state, attempts, next due time, claim token, lease expiry, receipt time, safe error code |

`UNIQUE(job_id,event_name)` enforces one logical event per attempt.
`UNIQUE(event_id,subscription_id)` enforces one delivery record per subscriber.
Foreign keys and useful due-delivery/subscription indexes are required.
No global sent flag belongs on the immutable event: ChatA and ChatB can have
different delivery outcomes. Do not delete events on first acknowledgment.
No automatic retention deletion in this release; document disk usage and a
future retention policy rather than deleting unreconciled records.

Initial policy choices, to be reviewed with the plan:

- Local development principal: `local-owner`, only in explicit private-tunnel mode.
- Production principal: trusted authentication context, never a caller-supplied job ID or header alone. Reject shared-mode startup without a configured principal resolver.
- Backfill old jobs to `local-owner` only when private single-user mode is explicitly selected; otherwise require an ownership migration.
- Store the DB in a mode-0700 directory, DB mode 0600, with the same restricted treatment for WAL/SHM; use host secret protection for shared deployments.
- Default subscription lifetime 24 hours; accept positive requested TTLs up to 7 days, no minimum inflation. For a no-expiry request, grant a finite 24 hours and report that expiration.
- First release has no protocol history replay: return `cursor: null`. An active subscription has durable delivery recovery; a newly created subscription gets the requested job's current terminal event if one exists.
- HTTP timeout 10 seconds; claim at most 20 records; dispatch concurrency 4; leases 60 seconds; idle wait 1 second, abortable on shutdown.
- Maximum 8 attempts total; retry after 5, 10, 20, 40, 80, 160, 300 seconds plus 0–20% jitter. Respect valid Retry-After for 429/503, capped at 300 seconds.
- Retry network/timeouts, 408, 429, and 5xx; stop other 4xx including 410/413, and stop 3xx without following redirects. These classifications are our policy beyond required protocol behavior.
- Maximum serialized webhook body 256 KiB. Reject oversized events before persistence; retain local diagnostics separately.

## PR 1 — MCP protocol upgrade and compatibility

**Deliverable:** modern discovery and tools work over `/mcp`, while existing
stateless tool clients still work. Events capability remains absent.

**Files:** modify `package.json`, lockfile, `server.mjs`, `server.test.mjs`,
`README.md`; create `plugins/audiogram-helper/mcp-http.mjs`,
`mcp-http.test.mjs`, and `docs/features/mcp-events-protocol.md`.

**Interfaces:** `createMcpHttpHandler({makeServer,eventHandler,principalResolver})`
returns `{handleNodeRequest(req,res,body),close()}`. With no event handler,
event methods return method-not-found. No unsupported events capability.

- [ ] Read the tagged SDK migration guide; resolve released compatible server/node/client versions with `npm view`, then pin exact versions and update the lockfile. Prefer the documented 2.3.1 server migration; if the tagged package is unavailable, record the exact evidence and revise this step before touching the runtime.
- [ ] Add HTTP contract tests for `server/discover`, `tools/list`, and `tools/call`; retain legacy initialization tests and Host/Origin/body-size/malformed JSON guards.
- [ ] Run the tests and confirm the missing modern-discovery behavior fails.
- [ ] Implement the SDK-supported modern/legacy serving boundary. SDK documentation describes `createMcpHandler(factory, {legacy: 'stateless'})`; use its released Node bridge. Keep the Node-to-Web adapter and response handling in `mcp-http.mjs`, not a fabricated version switch in tool code.
- [ ] Keep event-method routing behind the same authorization and request guards. The experimental Events vocabulary may require an explicit extension handler; do not assume SDK core registers it.
- [ ] Verify request-scoped resources close without closing the future process-wide subscription store/dispatcher.
- [ ] Add `test:mcp-events` to run `node --test plugins/audiogram-helper/mcp-*.test.mjs` as files appear; include relevant tests in CI/pre-push discovery.
- [ ] Run existing plugin tests and modern/legacy tests. Exercise discovery through the private tunnel without starting a video job; record the actual response.
- [ ] Reconcile the protocol slice note only, commit, push, and open/register PR 1. Attach its URL to the task. Begin PR 2 only after that PR exists.

Representative wire assertion (fixture helper starts the actual server):

```js
const reply = await rpc({ method: "server/discover", params: {} });
assert.ok(reply.result.supportedVersions.includes("2026-07-28"));
assert.equal(reply.result.capabilities.events, undefined);
```

## PR 2 — Shared terminal-event contract

**Deliverable:** one validated event builder, independently testable. This PR
does not yet persist events or claim crash-safe notification behavior.
This is the deliberate separation from PR 3's atomic database integration.

**Files:** create `plugins/audiogram-helper/mcp-event-contract.mjs`,
`mcp-event-contract.test.mjs`, and `docs/features/mcp-events-contract.md`.

**Interfaces:** export `EVENT_NAMES`, `TERMINAL_STATUSES`, `JobFinishedDataSchema`,
`EventEnvelopeSchema`, `buildJobFinishedEvent({job,result,eventId,timestamp})`,
and `toWebhookEnvelope(outboxRow)`. The builder is pure; IDs and time are inputs.

- [ ] Add enum/schema tests before implementation: reject unknown event names, running/queued states, invalid UUIDs, unsupported fields, invalid times, and oversized serialized payloads.
- [ ] Define a strict payload: `job_id`, optional `retry_of_job_id`, `status`, `failures[]`, and `artifacts[]`. Each failure has an existing allowed stage, stable safe code, and approved message; preserve package identifiers where available.
- [ ] Project allowlisted fields from trusted persisted job results. Never copy arbitrary exception messages into events. Require verified artifact references from the existing result validator.
- [ ] Require complete outcomes to contain verified artifacts; partial requires both artifacts and failures; failed/no_clips contain no verified artifacts. Do not label intentionally skipped Jev as failure.
- [ ] Implement shared constants and schemas without duplicating stage enums. Extract an existing stage contract only if needed, preserving the tool schemas.
- [ ] Test all four final statuses, linked retries, multiple package failures, and rejection of raw-log/secret fields.
- [ ] Run `node --test plugins/audiogram-helper/mcp-event-contract.test.mjs`, reconcile the slice note, commit, push, and open PR 2.

Wire shape; IDs here are illustrative, real schemas require UUIDs:

```js
const event = {
  eventId: "event-A", name: "audiogram.job.finished",
  timestamp: "2026-10-15T15:00:00Z",
  data: { job_id: "JobID-A", status: "failed", artifacts: [],
    failures: [{stage: "jev", code: "JEV_TIMEOUT", message: "Jev did not respond in time."}] },
  cursor: null,
};
```

The DB uses snake_case columns; the wire envelope uses protocol field names
`eventId`, `name`, `timestamp`, `data`, `cursor`. Validate that mapping once.

## PR 3 — Atomic finalization and durable outbox

**Deliverable:** terminal result and event are written together, once, across
every worker and runner failure path. No subscriptions or delivery claims yet.

**Files:** modify `job-store.mjs`, `job-store.test.mjs`, `job-worker.mjs`,
`job-worker.test.mjs`, `local-runner.mjs`, and its owning tests;
create `docs/features/mcp-events-outbox.md`.

**Interfaces:** add `store.finalizeJob(jobId,result)` returning
`{job,event,created}` and `store.getTerminalEvent(jobId)` returning an event
or null. Keep `setResult` as a compatibility wrapper through finalization;
make `setFailed` build a safe result and use the same path.

- [ ] Test migration of an existing jobs DB, repeated migration, rollback,
  duplicate identical writes, conflicting final writes, and two connections.
- [ ] In one BEGIN IMMEDIATE transaction: load job; reject unknown ID; verify
  outcome; reuse an identical final result/event or reject a conflicting write;
  update job; insert event; commit. Roll back both on any failure.
- [ ] Enforce the unique job/name index and preserve the first event ID,
  occurrence timestamp, and serialized payload across repeated writes.
- [ ] Test failure between result update and event insert using an injected
  transaction fault or SQLite trigger; neither change may persist.
- [ ] Route successful CLI results, contract failures, spawn failures, stale
  workers, and outer worker exceptions through finalization. Reopen/recheck
  state when a stale-worker write races actual worker completion.
- [ ] Existing final rows get no unsolicited replay on startup. On explicit
  subscription later, `getTerminalEvent` may materialize a missing event from
  a valid safe stored result in a transaction. Legacy error-only failed rows
  use a safe worker-level summary, not invented Jev attribution.
- [ ] Never turn outbox failure into a second contradictory failed outcome.
  Roll back, log a safe finalization error, and preserve recovery information.
- [ ] Run store/worker/server tests, reconcile the outbox slice, commit, push,
  and open PR 3.

Required assertion with a real temporary SQLite fixture:

```js
const first = store.finalizeJob(jobId, failedResult);
const again = store.finalizeJob(jobId, failedResult);
assert.equal(first.event.eventId, again.event.eventId);
assert.equal(again.created, false);
assert.equal(store.getJob(jobId).status, "failed");
```

## PR 4 — Subscriptions, callback verification, and dispatcher

**Deliverable:** working event discovery, subscription creation, safe signed
delivery, basic idempotent renewal/cancellation, and durable delivery leases.
Basic cancellation and expiration are required here; PR 5 strengthens recovery
and lifecycle races rather than shipping an incomplete protocol surface.

**Files:** create helper-local `mcp-event-store.mjs`, `mcp-events.mjs`,
`mcp-webhook.mjs`, `mcp-event-dispatcher.mjs`, and matching `mcp-*.test.mjs`;
modify `job-store.mjs` to share the same DB connection with event-store methods,
`server.mjs`, package/lockfile; create `docs/features/mcp-events-delivery.md`.

**Interfaces:**

```js
// Event store methods run on the jobs database; no network awaits in SQL transactions.
subscribe({principal, name, arguments: filters, delivery, ttlMs});
unsubscribe({principal, name, arguments: filters, delivery});
reconcileDeliveries({now}); // INSERT matching event/subscription pairs, ON CONFLICT no-op
claimDueDeliveries({now, limit, leaseMs}); // returns rows with unique claim tokens
acknowledgeDelivery({id, claimToken, now});
failDelivery({id, claimToken, now, code, httpStatus});
// Callback safety and cryptography remain outside the store.
verifyCallback({url, secret, subscriptionId, signal});
sendSignedEvent({subscription, event, signal}); // {accepted,httpStatus}
startEventDispatcher({store, webhook, clock, signal}); // {done,stop}
```

- [ ] Add migration tests for subscriptions/deliveries and job owner identity.
  Use dependency-injected principals for ownership tests; never trust arbitrary
  identity fields supplied in request bodies.
- [ ] Validate UUID filter, exact event name, HTTPS URL, signing-secret prefix
  and decoded length, callback address, and requested TTL. Persist only safe
  failure categories; do not echo secret values in JSON-RPC errors.
- [ ] Derive subscription identity from principal, callback URL, event name,
  and canonical filter JSON. Verify outside the transaction, then atomically
  activate the matching row; rejected challenges leave no active subscription.
- [ ] Implement `events/list`, `events/subscribe`, `events/unsubscribe` through
  the extension handler on `/mcp`; methods are not registered application tools.
  Return finite `refreshBefore`, `cursor: null`, and `truncated: false`.
- [ ] Verify callbacks with fresh single-use signed challenges. Require 2xx
  and a matching echoed challenge before activation. Give verification its own
  deadline and constant-time challenge comparison.
- [ ] Use Standard Webhooks signing on the exact body bytes. Reuse event ID on
  retries; sign each attempt afresh. Pin the signing dependency; test against
  independent verification, mutated-body rejection, and wrong-secret rejection.
- [ ] Implement callback transport that resolves and checks IPv4/IPv6 and
  mapped addresses at connection time, pins a validated address while preserving
  TLS hostname verification, blocks redirects, and never connects to loopback,
  private/link-local/multicast/reserved destinations. A preflight DNS check
  followed by ordinary fetch is not sufficient. Test rebinding and redirects.
- [ ] Reconcile pairs transactionally, then claim due rows with a lease/token.
  No transaction remains open during HTTP. Compare claim tokens on ack/failure;
  a late response from an expired claim cannot update the new owner's row.
- [ ] Run at most four sends concurrently with individual deadlines. Recheck
  active subscription, owner authorization, expiry, and callback secret version
  immediately before send. Do not let one slow subscriber block other jobs.
- [ ] Catch per-delivery errors and loop-level DB errors separately. On DB
  error, emit a safe service error and wait before retrying; do not hot-loop.
- [ ] Persist retry schedule/exhaustion. Stop loop on shutdown, abort requests,
  await completion, and close DB afterward. Unfinished leases recover later.
- [ ] Start the dispatcher once per service process, not once per HTTP request.
  Protect shared state when requests construct short-lived SDK server instances.
- [ ] Advertise events capability only when all required handlers and dispatcher
  dependencies are enabled. Keep existing tools usable with events disabled.
- [ ] Test two dispatchers, two subscribers, expiry, cancellation, forged job
  ownership, 2xx, 3xx, 410, 413, 429, 500, timeouts, and bounded exhaustion.
- [ ] Reconcile the delivery slice, run focused tests and plugin regressions,
  commit, push, and open PR 4.

Required isolated behavior test (fake transport, real DB):

```js
await dispatcherTick(); // claim, verify active subscription, send, acknowledge
assert.equal(fakeReceiver.requests[0].body.eventId, terminalEvent.eventId);
assert.equal(store.getJob(jobId).status, "complete");
// Repeat with a timeout: processing stays complete, delivery becomes due later.
```

Implement `dispatcherTick` as the testable one-iteration primitive exported by
`mcp-event-dispatcher.mjs`; the long-running loop calls it with the same inputs.

## PR 5 — Lifecycle races, recovery, and ChatGPT acceptance

**Deliverable:** the complete user experience, including late subscriptions,
renewal/rotation, cancellation races, restart recovery, and truthful chat claims.

**Files:** modify event modules/store tests, `README.md`, and plugin instruction
source; create `mcp-events.integration.test.mjs`,
`docs/features/mcp-events-lifecycle.md`, and
`docs/mcp-events-chatgpt-acceptance.md`.

No plugin instruction artifact is present in the inspected helper directory.
During this task, identify the owned plugin's actual editable instruction source
through the plugin management/creator tools. Keep a versioned copy in
`plugins/audiogram-helper/CHATGPT-INSTRUCTIONS.md`; apply changes to the owned
plugin only as part of the authorized execution/publication workflow.

- [ ] Race-test subscription before, during, and after finalization. Reconciliation
  must create exactly one pair whether the event or subscription commits first.
- [ ] Test late subscriptions to valid historical terminal rows and error-only
  legacy rows; preserve unknown stage attribution rather than inventing details.
- [ ] Renew before expiry using the same identity; extend the existing row,
  never duplicate delivery. Expired rows receive nothing until reauthorized and
  renewed. Refresh the requested job's terminal delivery without resetting an
  already acknowledged pair.
- [ ] Rotate signing keys with a bounded five-minute overlap. Protect key
  versions in storage; permit the two valid signatures during overlap, then
  retire the old key. Verify cancellation or newer renewal wins over a slower
  in-flight verification so it cannot reactivate stale state.
- [ ] Make unsubscribe idempotent and authorize using the original identity.
  Cancel pending claims; a request already sent can still be received. Test both
  sides of this boundary. Never cancel the rendering job as a side effect.
- [ ] Simulate process death after event commit, after claim, and after remote
  receipt. Reopen DB, recover expired leases, and preserve the event ID. Confirm
  duplicate receipt is possible and processing is never rerun by delivery code.
- [ ] Persist safe event/delivery IDs and error categories in diagnostics. Do
  not expose callback URL query strings, secrets, or raw webhook bodies in logs.
- [ ] Add plugin instructions: when the user requests updates, get the new job
  ID, subscribe to its finished event, confirm success before claiming monitoring,
  and report the final outcome when the event arrives. If subscription fails,
  say so and offer status lookup. Never automatically retry a processing failure.
- [ ] Test subscribed failed/partial/no-clips messages, no-monitoring requests,
  failed subscribe calls, and retries linked to the correct new attempt.
- [ ] In supported ChatGPT Work, refresh discovery, confirm the event catalog,
  request synthetic monitoring, verify challenge/subscription, receive a terminal
  webhook, and observe ChatGPT's response. Repeat with one explicitly approved
  real video attempt and stop monitoring afterward. Record IDs, outcome, protocol,
  and observed response without secrets. Webhook 2xx alone is not acceptance.
- [ ] Reconcile lifecycle note and the overall roadmap only after the live
  acceptance evidence exists; otherwise keep the implementation PR draft with
  honest IN_PROGRESS metadata. Commit, push, and open PR 5.

## Verification and PR readiness

- [ ] For each task, add the named failing behavior tests, run them red, implement,
  run green, and inspect the scoped diff. Use temporary databases and injected
  clocks/transport; never alter the user's actual job DB for automated tests.
- [ ] Include all new helper-local tests in explicit npm/CI commands; current
  `test:audiogram-plugin` names only server and startup tests and does not
  automatically discover every new helper test file.
- [ ] Run `npm run test:audiogram-plugin`, `npm run test:mcp-events`, targeted
  ESLint, `npm run lint`, `npm run verify:feature-docs`, and `git diff --check`.
- [ ] Run the normal pre-push hook; diagnose failures without bypassing it.
- [ ] Use feature-flow DESIGN before code and RECONCILE after verification for
  each slice. Declare its exact path in each PR body, for example
  `Feature-docs: docs/features/mcp-events-outbox.md` for PR 3.
- [ ] List dependent PRs and actual verification evidence. Keep unfinished
  implementation PRs draft. Documentation-only notes may remain DESIGN.
- [ ] Do not merge, deploy, restart the user's running service, or delete a
  worktree unless that operation is authorized at execution time.

## Sources and evidence boundaries

- OpenAI integration contract: https://developers.openai.com/plugins/build/mcp-events
- Experimental Events proposal: https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md
- SDK migration: https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/docs/migration/support-2026-07-28.md
- SDK package split: https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.1/README.md

Source-specific requirements: OpenAI requires the newer protocol, event-method
discovery/subscription, verified signed webhook delivery, and persistent
subscription state. Its integration is documented for Work web, desktop Work
Cloud, and dots. Our table design, timing limits, retry schedule, module names,
and five-PR division are proposed engineering choices, not OpenAI requirements.

No implementation, SDK installation, protocol migration, live subscription,
webhook delivery, or PR creation was performed while writing this plan.
