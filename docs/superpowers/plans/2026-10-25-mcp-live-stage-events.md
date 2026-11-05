# MCP Live Stage Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task, inline. Repository policy defaults to
> no subagents. Steps use checkboxes for tracking. Writing this plan authorizes
> no product implementation, installation, publication, or service restart.

**Goal:** A subscribed ChatGPT chat reports meaningful job progress, recovery,
and the verified final outcome without another user prompt.

**Architecture:** The existing normalized stage logger gains a durable SQLite
sink, with JSONL retained as a diagnostic mirror. The job store atomically
records the final result and finish event. An operator-visible dispatcher
delivers immutable facts to verified subscriptions, with replay and separate
delivery state; it does not run or control the pipeline.

**Tech Stack:** Existing Node ESM, Node SQLite WAL, Zod, the released MCP
server/client/Node packages needed for protocol `2026-07-28`, and Standard
Webhooks signing. Resolve and pin compatible published packages in Task 1;
require Node 22.13.0 or newer and do not assume a package version alone provides
protocol or Events support.

**Spec:** `docs/features/mcp-job-events.md`, approved 2026-10-25. This plan
supersedes `2026-10-15-mcp-job-events.md`, including its terminal-only unique
index and no-replay policy.

## Global Constraints

- Five dependent PRs; these are sequence labels, not GitHub PR numbers.
- Open/register PR 1 before starting PR 2. Base each later PR on merged main
  or its declared predecessor; do not include unrelated branch history.
- Use an isolated `codex/` worktree, never the checkout running MCP. Preserve
  `.env`, credentials, actual databases, and unrelated `scripts/dispatcher.mjs`.
- Implement inline. Use focused diff review and tests, not new reviewer agents.
- Event names: `audiogram.job.progress`, `audiogram.job.finished`.
- Progress kinds: `stage_started`, `stage_completed`, `stage_failed`,
  `stage_recovery`, `stage_skipped`.
- Final statuses: `complete`, `partial`, `failed`, `no_clips`.
- One existing stage source; one logical finish per attempt; at-least-once
  delivery. A retry is a new job ID and requires explicit user approval.
- Never synthesize skipped Jev as failure or treat package failure as job failure.
- Keep existing tools and template UI working. Health additions are additive.
- Do not send raw logs, transcripts, model output, secrets, or local paths.
- No inferred percentage, ETA, token streaming, or exactly-once display claims.
- Do not advertise events until discovery, subscription, replay, verification,
  dispatcher, and safe lifecycle behavior are operational.
- Operator starts the long-running service explicitly; workers never start a
  detached dispatcher. Ask before live services, tunnel/ChatGPT writes, or paid runs.
- Every task follows red test, minimal implementation, green test, scoped diff,
  and commit. Never bypass hooks or claim live acceptance from HTTP receipt.

## Review Focus

1. A job finishes before ChatGPT subscribes: replay still delivers the verified
   outcome without announcing old stages as running (Tasks 6, 9).
2. A crash separates stage execution, durable append, result capture, and SQL
   finalization: expose unknown coverage and recover the result without rerendering
   or overwriting success with a persistence error (Tasks 3–5).
3. Parallel clip stages and progress/finish subscriptions arrive out of order:
   maintain distinct stage instances and never regress a final result (Tasks 2, 7, 9).
4. Two subscribers or dispatchers race cancellation, renewal, and key rotation:
   preserve ownership, claims, and independent delivery health (Tasks 6–8).
5. A callback looks public at validation but resolves privately at connection:
   enforce destination safety during verification and every send (Task 6).

## Current baseline and file ownership

Read the actual branch and files again at execution time. The inspected tree
uses `@modelcontextprotocol/sdk@1.29.0`, `@modelcontextprotocol/ext-apps@1.7.5`,
Node SQLite, per-job JSONL diagnostics, and separate worker/CLI processes.
`emitPipelineEvent` swallows sink errors; bounded files are not a durable queue.
Current result persistence can overwrite success in catch paths and must be
separated from processing failure. No real Events integration exists yet.

All helper paths below are relative to `plugins/audiogram-helper/` unless a
full repository-relative path is shown. New modules own one responsibility:

| Files | Responsibility |
| --- | --- |
| `server.mjs`, new `mcp-http.mjs` | Preserve tools/UI; modern and legacy HTTP boundary |
| new `mcp-event-contract.mjs` | Names, safe projection, strict schemas, message templates |
| new `job-stages.mjs` | Shared stage vocabulary extracted from existing validators |
| new `mcp-event-store.mjs`, `job-store.mjs` | One jobs DB: migrations, event append, atomic finalization, queries |
| new `mcp-stage-sink.mjs` | Bounded logger-to-store writes and capture-health latch |
| `scripts/pipeline-logger.mjs`, `job-diagnostics.mjs` | Existing source identity and JSONL/durable fan-out |
| `scripts/audiogram-url.mjs`, `job-worker.mjs`, `local-runner.mjs` | Cross-process identity, result recovery, stale-worker handling |
| new `mcp-finalization.mjs` | Private recoverable final-result sidecar and persistence recovery |
| new `mcp-events.mjs`, `mcp-event-secrets.mjs` | Protocol subscriptions, authorization, cursor/secret protection |
| new `mcp-webhook.mjs` | Connection-safe HTTPS, verification, signing |
| new `mcp-event-dispatcher.mjs` | Lease/token claim, due sends, retry scheduling, orderly shutdown |
| new `CHATGPT-INSTRUCTIONS.md` | Versioned guidance for both subscriptions and truthful updates |

Create colocated `.test.mjs` files for new modules. Modify existing owning
tests for every changed boundary. `npm run test:ci` discovers helper and
scripts tests; retain its discovery tests. Never reuse `scripts/dispatcher.mjs`.

## Shared contract and policy

These values make the approved design executable. New numeric policies are
engineering defaults for plan review, not OpenAI requirements.

- Local mode: explicit `AUDIOGRAM_MCP_EVENTS_MODE=private-tunnel` resolves the
  sole trusted principal `local-owner`. Shared mode requires a trusted principal
  resolver; reject startup if absent. Never trust request-body identity.
- Events remain gated by `AUDIOGRAM_MCP_EVENTS_ENABLED=1` during rollout. False
  means no advertised capability or dispatcher; preserve ordinary tool operation.
- Same MCP jobs DB, not the processing ledger: `jobs`, `event_outbox`,
  `event_subscriptions`, `event_deliveries`. Private directory 0700, files 0600;
  secure WAL/SHM and backups too. Add migration-version bookkeeping there.
- Jobs add owner, stable run ID, last committed event sequence, and capture
  health. For this one-worker-per-attempt system, `run_id = job_id`; a new retry
  gets new IDs. Source-emission and stage-instance IDs are UUIDs.
- Envelope fields: `eventId`, `name`, `timestamp`, `data`, `cursor`. DB columns
  use snake_case. Payload `schema_version` starts at 1; sequence starts at 1.
- Progress data: `job_id`, `run_id`, optional `parent_job_id`, `sequence`,
  `kind`, `stage`, `stage_instance_id`, optional positive `stage_attempt`, fixed
  `message`; optional `clip_package_id`, `treatment_id`, `duration_ms`, `count`,
  and allowlisted `code`. Unknown fields fail validation.
- Finish data: same job identity/sequence, final `status`, all safe `failures`,
  verified `artifacts`, and `progress_history` (`complete`, `incomplete`, `unknown`).
  No invented failure attribution. `partial` requires a verified artifact and
  failures. Revalidate result artifacts before finalizing or replaying legacy data.
- Additive tool/result `notificationHealth`: `capture` with the same three
  states, and `delivery`: `not_subscribed`, `active`, `degraded`, or `stopped`.
  It is not job status; `diagnosticsIncomplete` keeps its existing file meaning.
- Stage sink: separate connection with 100 ms SQLite busy timeout, 3 total
  attempts, 50 ms then 100 ms waits, serialized appends; fail open with latched
  incomplete coverage. Never keep a transaction open across waits or HTTP.
- Other event-store writes: 5-second SQLite busy timeout. Finalization recovery
  waits 1, 2, 4, 8, 16 seconds after the first attempt; preserve the result after
  exhaustion for service recovery instead of rerendering.
- Subscription TTL default 24 hours, positive requested TTL capped at 7 days;
  grant finite 24 hours for no-expiry requests and report it accurately.
- Keep facts 30 days after finalization, extended through subscription/retry
  needs. Never purge running-job facts. Retain a per-stream deletion floor.
- Callback timeout 10 seconds; claim up to 20 rows, concurrency 4 across
  subscriptions, at most one in-flight row per subscription, 60-second leases,
  1-second abortable idle wait. Stop scheduling when shutdown begins.
- Eight sends maximum; delays 5, 10, 20, 40, 80, 160, 300 seconds with 0–20%
  jitter. Honor valid Retry-After on 429/503 up to 300 seconds. Retry network,
  408, 429, and 5xx; stop 3xx and other 4xx, including 410/413. No redirects.
- Application envelope limit 64 KiB, below the documented 256 KiB receiver
  maximum. Check exact serialized bytes before persistence and send.
- Signing-key overlap 5 minutes on rotation; verification cache 5 minutes,
  scoped to principal, callback, and secret version. Never log URLs with queries.

## PR 1 — Protocol migration without tool/UI regression

### Task 1: Establish the supported HTTP boundary

**Files:** modify package/lockfile, `server.mjs`, `server.test.mjs`,
`template-ui-resource.mjs` and its tests if required; create `mcp-http.mjs`,
`mcp-http.test.mjs`, `docs/features/mcp-events-protocol.md`.

**Interfaces:** `createMcpHttpHandler({makeServer, eventHandler,
principalResolver}) -> {handleNodeRequest(req,res,body), close()}`.
With no enabled event handler, Events methods return method-not-found and
capabilities omit `events`; all existing tools and template resources remain.

- [ ] Read the v1-to-v2 migration, modern-protocol entry, and Node bridge docs.
  Check published versions and peer dependencies with `npm view`; record a
  compatible server/client/Node/ext-apps package matrix in the slice note before
  dependency changes. Preserve a v1 dependency only if the UI bridge requires it.
  If no published supported combination passes the matrix, stop and revise
  this task; do not invent a protocol handler or strip the template UI.
- [ ] Write HTTP contract tests: modern `server/discover` reports `2026-07-28`,
  legacy initialize/tools still work, all four tools remain, and template UI
  resource metadata/HTML still resolve. Test malformed JSON, Host/Origin guards,
  body limit, unauthorized identity, and request closure.
- [ ] Run `node --test plugins/audiogram-helper/mcp-http.test.mjs` red; expect
  missing modern discovery/adapter. Do not alter expectations to hide regressions.
- [ ] Pin the verified released versions and implement the SDK-supported
  serving boundary. The documented modern entry is `createMcpHandler`; configure
  legacy stateless support and the supported Node adapter. Keep extension
  dispatch under the same guards, not in an application tool called subscribe.
- [ ] Run `npm run test:audiogram-plugin` and `npm run test:ci`; expect all
  files pass, including template UI tests. Record package versions and actual
  modern/legacy responses. A private-tunnel discovery test requires operator approval.

Required assertions inside the modern wire fixture:

```js
assert.ok(discovery.result.supportedVersions.includes("2026-07-28"));
assert.equal(discovery.result.capabilities.events, undefined);
assert.ok(resources.some((entry) => entry.uri === "ui://video-templates/v1.html"));
```

- [ ] Reconcile the protocol note, run document/lint/diff gates, commit as
  `feat: support modern MCP HTTP without tool regressions`, push, open/register
  PR 1, and attach its URL. Stop before PR 2 until that PR exists.

## PR 2 — Shared progress and final-event vocabulary

### Task 2: Define strict, safe event builders

**Files:** create `mcp-event-contract.mjs`, `mcp-event-contract.test.mjs`,
`job-stages.mjs`, `docs/features/mcp-events-contract.md`; modify stage consumers
in `server.mjs` and `result-validation.mjs` without changing allowed stages.

**Interfaces:** export `EVENT_NAMES`, `PROGRESS_KINDS`, `TERMINAL_STATUSES`,
`ProgressDataSchema`, `FinishedDataSchema`, `EventEnvelopeSchema`,
`projectStageFact({job, normalized, sourceId, stageInstanceId, stageAttempt})`,
`buildProgressEvent({job,fact,eventId,sequence,timestamp})`,
`buildJobFinishedEvent({job,result,eventId,sequence,timestamp,capture})`, and
`toWebhookEnvelope(event,{cursor})`. Builders are pure; callers supply IDs/time.

- [ ] Write failing tests for both names and every kind/status; assert
  `retrying -> stage_recovery`, explicit skipped Jev -> `stage_skipped`, unknown
  stage/kind rejected, no fabricated skipped failure, and fixed safe messages.
- [ ] Add tests for distinct clip/treatment identity, optional unknown attempt,
  one stage instance across selection recovery, all package failures preserved,
  and rejection of raw text, secrets, invalid UUIDs, unknown fields, invalid
  sequences/timestamps, and bodies above 64 KiB.
- [ ] Run `node --test plugins/audiogram-helper/mcp-event-contract.test.mjs`
  red. Implement strict schemas and the existing vocabulary's extraction;
  require already verified artifacts, with no provider/network calls in builders.
- [ ] Assert final status rules, including `partial` with verified artifacts;
  stage completion must never build a finish event. Run the focused test green
  and all plugin regressions.
- [ ] Reconcile the contract note, run standard gates, commit as `feat: define
  safe job progress and finish events`, push, and open PR 2.

## PR 3 — Durable capture across logger, CLI, and worker

### Task 3: Store immutable facts and finalize atomically

**Files:** create `mcp-event-store.mjs`, `mcp-event-store.test.mjs`,
`docs/features/mcp-events-capture.md`; modify `job-store.mjs` and its tests.

**Interfaces:** `createJobStore(filename, options)` retains existing methods
and adds `appendProgress({jobId,sourceId,fact}) -> {event,created}`,
`finalizeJob(jobId,result,{capture}) -> {job,event,created}`,
`getEvent(eventId)`, `listJobEvents({jobId,name,afterSequence,limit})`, and
`getCaptureHealth(jobId)`. No SDK, callback, or secret key is required to append.
An internal event-store adapter shares the jobs connection; other processes
open their own connection to the same file. Do not nest SQL transactions.
Extend options with `busyTimeoutMs` (default 5000); the stage sink uses 100
on its own connection, without changing the service/finalizer connection.

- [ ] Write real temporary-SQLite tests for migration, repeated migration,
  rollback, legacy rows, duplicate source writes, two connections, and stable
  sequence allocation. Unknown job IDs and late progress after finish must fail.
- [ ] Test fault injection between job update/event insert: both roll back.
  Identical final writes return the same event; conflicting final writes reject.
  An invalid artifact result cannot create an event or change the job.
- [ ] Run the new store tests red. Implement transactional append/finalize,
  canonical JSON and byte limits, foreign keys/indexes, and the private-file
  policy. Migrate owner only in explicit single-owner mode; shared ownership
  without a trustworthy mapping blocks Events activation, not ordinary tools.
- [ ] Use `UNIQUE(job_id,source_id)`, `UNIQUE(job_id,sequence)`, and a partial
  unique finish index on `job_id WHERE event_name='audiogram.job.finished'`.
  Do not use the old global `UNIQUE(job_id,event_name)` for progress facts.
- [ ] Keep `setResult`/`setFailed` compatibility wrappers through finalization.
  Safe legacy terminal materialization occurs only on authorized subscription,
  with coverage unknown and revalidated artifacts; never invent old stage facts.
- [ ] Run store/plugin tests green, inspect migration SQL, and commit as
  `feat: persist ordered job facts and atomic finish results`. PR 3 stays draft.

Required assertions in the temporary store fixture (`jobId`, `sourceId`,
`fact`, and `verifiedResult` are locally generated safe test inputs):

```js
const first = store.appendProgress({jobId, sourceId, fact});
const duplicate = store.appendProgress({jobId, sourceId, fact});
assert.equal(first.event.eventId, duplicate.event.eventId);
assert.equal(duplicate.created, false);
const finished = store.finalizeJob(jobId, verifiedResult, {capture: "complete"});
assert.equal(store.finalizeJob(jobId, verifiedResult, {capture: "complete"}).event.eventId,
  finished.event.eventId);
assert.throws(() => store.appendProgress({jobId, sourceId: anotherId, fact}), /finalized/);
```

### Task 4: Connect the existing structured logger durably

**Files:** create `mcp-stage-sink.mjs` and tests; modify
`scripts/pipeline-logger.mjs` and tests, `job-diagnostics.mjs` and tests,
`scripts/audiogram-url.mjs` and tests, `scripts/youtube-inbox-pipeline-core.mjs`
for explicit recovery metadata, and `scripts/single-url-pipeline.mjs` only
where job/run context is threaded.

**Interfaces:** `createStageEventSink({store,job,clock,sleep}) ->
{record(normalized), flush(), captureState(), close()}`; `record` returns
`{persisted,eventId?,sequence?}`. `createPipelineLogger` accepts optional
`durableSink`; its `.event()` interface remains compatible. Extend normalized
fields with `sourceId`, `stageInstanceId`, `stageAttempt` and preserve existing
fields. `runLoggedStage` assigns/reuses invocation identity automatically.

- [ ] Write red tests: one pipeline emission reaches durable storage and JSONL
  once; replaying its source ID deduplicates; concurrent clip stages keep
  different instance IDs; recovery and completion keep the original instance.
- [ ] Test bounded sink failure versus JSONL truncation separately. Assert
  durable facts survive file truncation, sink failure latches incomplete coverage,
  failed mirrors do not erase durable facts, and no provider/output text is stored.
- [ ] Implement the same-source fan-out, durable-first bounded write, and flush.
  Use explicit stage context for recovery rather than reading a global current
  stage, which is unsafe for parallel work. Do not infer stage attempts from
  logger `count`, which can also mean clip count.
- [ ] CLI/worker environment carries `AUDIOGRAM_EVENT_STORE_PATH`, job/run IDs,
  and capture-enabled state, not a function or signing secret. CLI opens its
  own stage sink only in managed mode; standalone CLI retains existing behavior.
  Reject mismatched job/run identity before recording; strip the future
  `AUDIOGRAM_EVENT_SECRET_KEY` from worker/CLI inherited environments.
- [ ] Add `notificationHealth.capture` to CLI output after flushing/closing the
  sink. Keep diagnosticsIncomplete independent. Test this through real child
  processes and a temporary DB, not just injected in-memory callbacks.
- [ ] Run logger/CLI/sink/selection tests green and commit as `feat: capture
  stage progress through the existing cross-process logger`. No callback yet.

### Task 5: Preserve final results through crashes and persistence failure

**Files:** create `mcp-finalization.mjs` and tests; modify `job-worker.mjs`,
`local-runner.mjs`, `result-validation.mjs`, server output schema, and owning tests.

**Interfaces:** `persistFinalResult({store,jobId,result,capture,recoveryRoot,
clock,sleep}) -> {finalized,eventId?}`;
`recoverPendingFinalizations({store,recoveryRoot,validateResult}) -> summary`.
Use fixed per-job `finalization-result.json` sidecars under private diagnostics
directories; never accept a caller-supplied arbitrary path. Results are trusted
only after job identity, source, selection, result schema, and artifacts validate.

- [ ] Test worker success followed by event-store failure: keep its verified
  result, leave finalization pending, and never overwrite it as processing failure.
  Test missing/partial/oversized or wrong-job sidecars and changed artifact bytes.
- [ ] Write the safe sidecar with exclusive private temp file, flush/fsync,
  atomic rename, and directory durability before the first finalization attempt.
  Reuse it during bounded retry; remove only after confirmed atomic commit.
  If even sidecar persistence fails, retain existing CLI result diagnostics and
  raise a safe finalization-health alert; do not claim recoverability or rerender.
- [ ] Separate result acquisition/validation from persistence catch blocks.
  Flush all progress before finalization; process death implies unknown coverage
  unless a validated completed capture report exists. All runner spawn/stale
  paths use real worker failure facts and the same atomic finalizer.
- [ ] On service recovery and before declaring a stale worker failed, check
  pending finalization first. Revalidate/recover the result without running CLI.
  Race actual completion against stale-worker handling on two DB connections.
- [ ] Stop status-read paths from mutating a finalized result when previously
  verified media becomes unavailable. Still revalidate artifacts on lookup;
  return a safe artifact-availability error separately (tool error response,
  no unsafe paths), without a job rewrite or second finish. Test deleted and
  modified media after finalization and late replay: never advertise them as
  currently verified or silently change the historical processing outcome.
- [ ] Add tests for abort/crash after append, after sidecar rename, before/after
  commit, and before sidecar removal. Assert one logical finish, unchanged
  artifacts, no extra generation call, and rejected late progress.
- [ ] Run all owning tests and CI green; reconcile the capture slice. Commit as
  `fix: recover finish persistence without rerunning successful work`, push,
  and open PR 3. It does not advertise remote delivery.

## PR 4 — Safe subscriptions, replay, and durable dispatcher

### Task 6: Verify callbacks and activate replayable subscriptions

**Files:** create `mcp-events.mjs`, `mcp-event-secrets.mjs`, `mcp-webhook.mjs`
and tests; extend `mcp-event-store.mjs` and tests;
create `docs/features/mcp-events-delivery.md`.

**Interfaces:** `createEventMethods({store,webhook,secrets,clock}) ->
{handleEventRequest({principal,method,params})}`;
`subscribe({principal,name,arguments,delivery,ttlMs,cursor})`,
`unsubscribe({principal,name,arguments,delivery})`,
`reconcileDeliveries({now})`, `pruneEventHistory({now})` on the store;
`verifyCallback({url,secret,subscriptionId,signal})`,
`sendSignedEvent({subscription,event,signal}) -> {accepted,httpStatus,retryAfter?}`.
Secret module: `createEventSecrets({key,keyVersion}) ->
{sealSecret(secret), openSecret(sealed),
encodeCursor({principalId,jobId,name,sequence}),
decodeCursor(token,{principalId,jobId,name})}`. Clock, principal, and key inputs
come from trusted service setup, not public tool arguments.

- [ ] Write failing ownership/filter/TTL/identity tests and cryptographic
  known-vector tests. Require HTTPS and `whsec_` secrets decoded to 24–64 bytes.
  Persist encrypted secrets (AES-256-GCM, versioned key from the operator), never
  plaintext; use a separate derived HMAC purpose for authenticated opaque cursors.
  Missing protection key fails Events startup. Do not print keys or install one.
- [ ] Test callback verification with fresh single-use challenges, deadline,
  exact echoed challenge, and constant-time comparison. Verify outside SQL;
  CAS activation by subscription version prevents a slow verification from
  undoing cancellation, renewal, expiry, or key rotation.
- [ ] Test independent signature verification of exact body bytes, tamper and
  wrong-secret rejection, fresh signing timestamps on resend, and size bounds.
  Use a maintained signing library pinned after checking its published release.
- [ ] Implement destination validation at connection time, pin validated public
  IPs while retaining hostname/TLS checks, and forbid redirects. Test IPv4,
  IPv6/mapped private, loopback, link-local, multicast/reserved, DNS rebinding,
  and mixed DNS answers; reject the set if any answer is not public. No ordinary
  fetch after a separate DNS preflight.
- [ ] Implement Events methods, both catalog schemas, idempotent subscription
  identity (principal + callback + name + canonical filters), and TTL policy.
  Backfill subscriptions from a single activation transaction/watermark; later
  reconciliation uses unique event/subscription pairs so races cannot lose facts.
- [ ] Add replay tests for before/during/after a fast job, both event streams,
  renewal, restarts, independent subscribers, expired cursors, forged/cross-owner
  cursors, and retention gaps. A null cursor means retained catch-up, not no-replay.
  Persist a deletion floor per job/name; return truthful truncated history and
  safe current status without manufacturing an outbox event for old stages.
- [ ] Run all new focused tests green and commit as `feat: add verified
  job subscriptions with durable replay`. PR 4 stays draft; no capability yet.

### Task 7: Deliver in order without blocking final outcomes

**Files:** create `mcp-event-dispatcher.mjs` and tests; extend event-store tests.

**Interfaces:** store `claimDueDeliveries({now,limit,leaseMs})`,
`acknowledgeDelivery({id,claimToken,now})`,
`failDelivery({id,claimToken,now,code,httpStatus,retryAfter})`;
`dispatcherTick({store,webhook,clock,signal,random}) -> summary`;
`startEventDispatcher(options) -> {done,stop}`. Inject clocks/random/transport.
Tick summary is `{claimed,sent,acknowledged,failed}` with nonnegative counts.

- [ ] Write red tests with real SQLite and a fake receiver: every eligible
  fact gets one delivery row, same-subscription order is respected, and two
  dispatchers cannot concurrently claim it. Lost acknowledgment reuses event
  identity; an expired claim token cannot update a new owner's record.
- [ ] Implement claim/lease CAS and the numeric retry policies above. Recheck
  ownership, state, expiry, callback/key version immediately before each send.
  Never hold SQL across HTTP. Per-subscription head-of-line ordering prevents
  newer progress overtaking pending older progress at the sender.
- [ ] On permanent failure/exhaustion mark that stream degraded/stopped; do
  not advance its acknowledged replay cursor over the gap. An independent
  finish subscription can still deliver. Test progress blocked while finish
  succeeds; event IDs and sequences let the client identify late progress.
- [ ] Test every response class, Retry-After, jitter bounds, eight-attempt cap,
  four-send concurrency, individual timeout, and DB-error backoff. Completion
  remains complete when delivery fails; dispatcher never invokes a runner.
- [ ] Run dispatcher/store tests green, commit as `feat: dispatch leased
  job events with bounded delivery recovery`.

Required fake-receiver assertions after an injected timeout and retry:

```js
assert.equal(receiver.requests[0].body.eventId, receiver.requests[1].body.eventId);
assert.notEqual(receiver.requests[0].signature, receiver.requests[1].signature);
assert.equal(store.getJob(jobId).status, "complete");
assert.equal(runnerCalls.length, 0);
```

Advance the injected clock between sends; fresh timestamps are tested, not
assumed from two same-second signatures.

### Task 8: Bind lifecycle, health, and operator-visible startup

**Files:** modify `server.mjs`, `local-runner.mjs`, `runtime-config.mjs`,
`README.md`, root `.env.example`, and owning tests; add
`mcp-events.integration.test.mjs`. Extend `validateMcpRuntimeConfig` in the
existing config module; do not create a second validator. Add notificationHealth
to tools/results as defined above.

**Interfaces:** server `startMcpServer` owns one shared event store/dispatcher,
while request-scoped MCP instances use it without closing it. Shutdown stops
claims, aborts sends, awaits dispatcher, then closes DB. Existing `.close()`
becomes awaitable for these resources; preserve its prior call sites.

Thread trusted principal from the request context into internal
`runner.start({url,videoId,templateSelection,principal})`,
`runner.getStatus(jobId,{principal})`, and `runner.retry({jobId,principal})`.
Store creation receives a trusted `ownerId`; lookup/retry and active-video
deduplication must check owner before returning an existing ID or result. Do
not add an owner field to public tool arguments. Cross-owner busy video errors
must not expose the existing job ID. Events-off private tools keep their
existing single-user behavior.

- [ ] Test feature-off compatibility, private/shared mode ownership, missing
  protection key, legacy owner migration, restart recovery, and UI/tool schemas.
  Test no callback secret/key leaks through worker env, logs, or errors.
- [ ] Test renewal with five-minute dual signatures, cache-key scoping, expiry,
  idempotent cancellation before claim/after claim/during send, and competing
  subscription versions. No case cancels the rendering job.
- [ ] Start the dispatcher only inside the explicitly launched MCP service.
  Run finalization recovery before stale-worker classification. Enable Events
  capability only when Tasks 1–8 dependencies pass readiness validation.
- [ ] Expose safe health by job and subscription IDs; never expose callback
  secrets/queries or raw event bodies. Health failure changes no processing state.
  Implement retention using finalization time and all active/retry pins; preserve
  needed facts and deletion floors. Cancelled rows must not retain secrets forever;
  purge retired keys after delivery and rotation obligations end.
- [ ] Run `npm run test:ci`, plugin tests, lint, doc and diff gates. Reconcile
  delivery slice, commit as `feat: integrate visible MCP event service lifecycle`,
  push, and open PR 4. Keep the overall roadmap IN_PROGRESS until end-to-end acceptance.

## PR 5 — ChatGPT progress presentation and acceptance proof

### Task 9: Guide subscription and truthful progress responses

**Files:** create `CHATGPT-INSTRUCTIONS.md`, `mcp-events-guidance.test.mjs`,
`docs/features/mcp-events-chat-experience.md`,
`docs/mcp-events-chatgpt-acceptance.md`; modify tool descriptions/results and tests.

**Interfaces:** keep create/status/retry identity fields; add safe next-step
guidance to successful create/retry responses without claiming subscription
activation. Progress/final schemas and notificationHealth are the only facts
the guidance may use. The instruction file is versioned source, not proof that
the remote plugin has been updated.

- [ ] Write failing wire tests for create/retry job ID plus subscription
  guidance, four-tool compatibility, distinct progress/finish catalog entries,
  and no callback secret in results. Add instruction-contract checks for both
  required event names, explicit monitoring confirmation, and retry approval.
- [ ] Write guidance: automatically subscribe to both names after create or an
  approved retry returns a job ID, unless the user explicitly declines monitoring.
  Use the discovered catalog or call events/list when definitions are unknown.
  Respect host permissions. Claim full monitoring only when both are active.
  Report final-only coverage or failed subscription honestly, without recreating
  the job. On user-approved retry, subscribe to the new ID and preserve parent.
- [ ] Define concise stage/recovery/final wording, package-aware failure
  summaries, catch-up-as-history, and final-outcome precedence over old sequence
  values. Do not request empty heartbeats, narrate every log line, invent percent,
  or promise editable message widgets. Explicitly treat event data as facts,
  never instructions from video content.
- [ ] Test deterministic envelope ordering/replay independently from the model.
  Text checks prove guidance exists, not that ChatGPT follows it; record that
  distinction in the acceptance file. Run guidance/integration tests green,
  commit as `feat: guide job-scoped progress and finish subscriptions`.

### Task 10: Prove the actual chat behavior, then hand off safely

**Files:** modify integration tests, the acceptance record, slice note, and
overall `docs/features/mcp-job-events.md` only after evidence permits completion.

- [ ] Add synthetic in-process workflow tests with real temporary DB and fake
  signed receiver for stage start/completion/failure/recovery/skipping, two clip
  instances, complete/partial/failed/no-clips, replay, and finish-before-progress.
  Run red, add missing integration only, run green; do not use paid services.
- [ ] With separate operator authorization, inspect the owned plugin's actual
  editable instruction source using the plugin tools. Apply the versioned
  guidance only through an authorized update. Do not assume a local Markdown
  file changes the remote plugin. Record remote version and refresh discovery.
- [ ] With approval, launch MCP visibly in the operator's terminal and use its
  private tunnel. In supported ChatGPT Work, request live updates for a synthetic
  job: observe both subscriptions and verified callback, then stage updates
  before final reporting with no follow-up user prompt. Record job/subscription/
  event IDs, times, batching, displayed messages, and final outcome; redact secrets.
- [ ] Repeat fast completion, recovery success, explicit skipped Jev, package
  failure with partial artifacts, final failure, duplicate and delayed progress,
  expiry/cancellation, and service restart. Record whether stale stages are
  narrated or replies flood the chat. No fabricated latency or display guarantee.
- [ ] Only with explicit approval, run one real video attempt for final smoke.
  A separate renderer proof, if requested, uses the repository verification
  skill and synthetic fixture; no Instagram publish is ever a verification step.
- [ ] If only webhook receipt is observed, keep the chat-experience PR draft
  and document the exact failed criterion. Do not mark the overall feature
  complete or relabel manual status polling as automatic progress acceptance.
- [ ] After actual acceptance, reconcile the chat slice and overall roadmap,
  run all gates, commit as `test: prove subscribed ChatGPT progress end to end`,
  push, and open PR 5. Record unmet criteria honestly; never change metadata
  merely to push or merge. Merge/deploy/cleanup still require user instructions.

## Verification, slice notes, and rollout

- Per task run focused `node --test` commands for its listed owning tests.
  `npm run test:audiogram-plugin` currently discovers helper tests; `npm run
  test:ci` discovers scripts, helper, and publishing tests. Check that new files
  appear in CI discovery rather than assuming the old explicit server-only list.
- Before each PR: full CI, plugin tests, targeted ESLint with Node globals,
  `npm run lint`, `npm run verify:feature-docs`, and `git diff --check`. Review
  fixtures for real secrets/job outputs; use temporary synthetic records only.
- Feature-flow DESIGN before each slice; RECONCILE only after its proof exists.
  PR bodies declare their note: protocol, contract, capture, delivery, or
  chat-experience respectively. Keep unfinished implementation PRs draft.
- Do not label this whole feature COMPLETE just because storage/delivery tests
  pass; the live ChatGPT acceptance record is required. The roadmap is DESIGN
  during planning and IN_PROGRESS during execution, with design-reviewed true
  and reconciliation false until end-to-end acceptance.
- Rollout is an explicit later operation: back up the job DB; stop accepting
  new work and drain/reconcile workers before activating the new write path;
  migrate before restart, then use operator-managed visible service startup.
  Do not change AUDIOGRAM_PACKAGE_VERSION unless a processing recipe also changes.
- Roll back by stopping event delivery and returning to the known-good tool
  service; preserve additive tables, event IDs, sidecars, and verified results.
  Do not drop data or rerender. Never silently downgrade a partly migrated DB.
- This planning pass changes documents only and runs document checks. It does
  not install dependencies, change schema, launch a service, contact a callback,
  update a plugin, or create a PR.

## Sources and evidence boundaries

- [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)
  defines subscription/webhook integration; receipt is not chat-response proof.
- [MCP v1-to-v2 migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2)
  and [modern protocol migration](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28)
  guide Task 1. Recheck released package manifests and UI compatibility there.
- Context7 was unavailable during planning, so primary documentation was used.
  SDK/event support and the target ChatGPT surface need execution-time proof.

The four-table layout, health fields, limits, secret/cursor storage, module
interfaces, and five-PR split are engineering decisions, not OpenAI mandates.
