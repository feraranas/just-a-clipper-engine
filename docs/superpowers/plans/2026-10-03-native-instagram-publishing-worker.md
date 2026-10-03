# Native Instagram Publishing Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Execute inline; no subagents by default under the repository cost policy.

**Goal:** Publish explicitly approved Audiograms Reels through Meta's Facebook Login API, with real-account validation and durable duplicate-prevention boundaries.

**Architecture:** Preserve the local approval UI and SQLite ledger. Add a streaming Meta adapter and a separate one-shot worker with account-scoped claims, durable phase checkpoints, an exclusive execution lock, and conservative crash reconciliation. Replace the older R2 upload design with direct resumable uploads.

**Tech Stack:** Node ESM, built-in fetch/streams/test runner, node:sqlite, existing local HTML/JS UI. No new runtime dependency planned.

**Spec:** `docs/features/native-instagram-publishing-worker.md` (written design approved in conversation).

## Global Constraints

- Work only in `/Users/kiwi/.codex/worktrees/native-instagram-publishing/Audiograms`, branch `codex/native-instagram-publishing`.
- Do not modify the original checkout, its SQLite database, credentials, or uncommitted files.
- Development uses an explicitly selected isolated ledger and artifact root.
- Credentials must be provided explicitly, never silently discovered from another checkout.
- Target username `theballooninquiries`, Instagram ID `17841411025933729`, Page ID `1367664856427450`; verify the relationship at runtime.
- One item per invocation; no automatically installed scheduler or unattended loop.
- Live testing is authorized, including real posts; each test still uses one specifically approved clip/caption.
- No Upload-Post, R2, automatic deletion, or blanket approval of legacy queue entries.
- Read retries are bounded; ambiguous writes are never blindly repeated.
- Do not mark implementation complete without real Meta validation. Deterministic tests complement, not replace, live results.

## Commit discipline and execution gate

- Commit frequently: each small, cohesive, independently reviewable change gets
  its own commit. The task-end commits below are a minimum, not a maximum.
- Keep tests and the implementation they validate together; prefer passing,
  bisectable checkpoints rather than arbitrary file-by-file or broken commits.
- Separate prerequisites, schema changes, adapter behavior, worker orchestration,
  CLI changes and documentation when they can be reviewed independently.
- Before each commit, inspect the staged diff, run the relevant checks, and stage
  explicit paths only. Never include secrets, generated media, databases or
  unrelated changes. Use descriptive messages explaining the change's purpose.
- Do not squash or rewrite this incremental history without user approval.
- The design and plan are being submitted for PR review first. Do not start
  implementation or live publishing until the user explicitly says GO.

## Review Focus

1. Caption edit races a claim: transaction must either invalidate approval first or reject the edit (Task 1).
2. Old worker wakes after a timeout: exclusive owner checks and fail-closed stale lock handling must prevent concurrent writes (Task 2).
3. File replaced between approval and upload: hash and stream the same opened file; fail if metadata changes during validation (Task 3).
4. Meta accepts publish but response/local commit is lost: reconcile existing container; never publish again automatically (Task 4).
5. Unexpected redirect or upload URI leaks credentials: HTTPS/host allowlist, redirects disabled, sanitized errors (Task 3).

## API reference checkpoint

Before coding the adapter, use Context7 to refresh Facebook Login content publishing,
resumable upload, container status and Page token requirements. Check Node fetch stream
requirements in current Node documentation. Pin Graph version through validated config;
`v26.0` was observed in the successful live account checks. Never use Instagram Login
permission names or its refresh endpoint for this Page-token integration.

- https://developers.facebook.com/documentation/instagram-platform/content-publishing
- https://developers.facebook.com/documentation/instagram-platform/content-publishing/resumable-uploads
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/business-login-for-instagram

## File map

Modify ledger/config/server and their existing tests; add `scripts/publishing-execution.mjs`
and tests for execution checkpoints/locking; add `scripts/instagram-client.mjs` and tests;
add `scripts/publishing-worker.mjs` and tests; add `scripts/publishing-run.mjs` and CLI
tests. Update `public/publishing/app.mjs` and its tests only for caption reapproval and
safe retry feedback. Add a runbook at `docs/native-instagram-publishing.md`, a sanitized
live record at `docs/research/native-instagram-live-validation.md`, package commands,
and placeholder configuration in `.env.example`. Never copy actual credentials there.

## Task 1: Approval snapshots, account-scoped claims and safe retry

**Files:** `scripts/publishing-ledger.mjs`, `scripts/publishing-ledger.test.mjs`,
`scripts/publishing-server.mjs`, `scripts/publishing-server.test.mjs`,
`public/publishing/app.mjs`, `public/publishing/app.test.mjs`.

**Interfaces:** Keep existing ledger constructor and enqueue API. Extend
`claimDueApprovedItem(at, {accountId, itemId} = {})` without changing existing callers;
the new worker always supplies both filters. Add `retryFailedItem(id)` and
`safeToRetry` on mapped items. Add `approvedCaption` to the persisted approval snapshot.

- [ ] Add additive schema migrations using `PRAGMA table_info`, inside a transaction;
  add `approved_caption TEXT` and `safe_to_retry INTEGER NOT NULL DEFAULT 0`.
  Legacy approved rows without a caption snapshot must not be published; return them
  to explicit review, never infer a historical approval.
- [ ] Add failing tests in temporary databases for these exact behaviors:

```js
assert.equal(ledger.approveItem(id, due).approvedCaption, 'approved caption');
assert.equal(ledger.updateCaption(id, 'changed caption').state, 'queued');
assert.equal(ledger.getPublishingItem(id).approvedAt, null);
assert.equal(ledger.claimDueApprovedItem(now, {accountId: 'other', itemId: id}), null);
assert.throws(() => ledger.retryFailedItem(ambiguousId));
```

  Build fixtures using the existing enqueue test helper pattern. Add two-connection
  tests for edit-before-claim and claim-before-edit, plus unchanged-caption no-op,
  future schedule, rejected item, and migration of an existing schema.
- [ ] Run `node --test scripts/publishing-ledger.test.mjs`; confirm new assertions fail.
- [ ] Make caption mutation transactional. On a changed approved caption, clear
  approval decision/time/hash/caption/schedule and return to queued. Reject edits
  after claim. Approval stores the current caption. Worker eligibility requires
  approval decision, snapshot, matching account/item and due timestamp.
- [ ] Replace server retry transition with `retryFailedItem`; reject unknown or
  unclassified failures. Retry returns safe failures to queued for fresh approval.
  Reset execution references only after explicit safe retry, retaining attempt history.
- [ ] Add route/UI tests showing a caption change reloads queued state and prompts
  reapproval. Add the missing `join` import and a default-publicRoot server test.
- [ ] Run ledger, server and client tests; inspect the focused diff. Commit only these
  files with `fix: enforce publishing approval snapshots and safe retries`.

## Task 2: Durable execution phases and exclusive ownership

**Files:** create `scripts/publishing-execution.mjs` and `.test.mjs`; modify ledger
schema/mapping/tests only for execution integration.

**Interfaces:** `createPublishingExecution(dbPath)` returns
`beginAttempt(itemId) -> attemptId`, `checkpoint(attemptId, phase, patch)`,
`getAttempt(itemId)`, and `close()`. `acquireWorkerLock(dbPath)` returns
`{assertOwned, release}`. Attempt phases:
`claimed`, `create_requested`, `container_created`, `upload_requested`,
`processing`, `publish_requested`, `published`, `failed`, `unknown`.
Patches allow containerId, uploadUri, mediaId, errorCode and safeToRetry only.

- [ ] Add a SQLite attempts table with UUID primary key, item ID, monotonically
  ordered creation timestamp, phase, external IDs, safe failure flag and timestamps.
  Keep historical attempts; transactions must persist each write-intent checkpoint
  before its corresponding external request. Terminal outcome and ledger state
  must be committed atomically on the same database connection/transaction.
- [ ] Write tests for persisted/reopened checkpoints, forbidden phase regression,
  rejection of token/unknown patch fields and atomic terminal updates.
- [ ] Use an exclusive lock directory adjacent to the explicit DB path; write owner
  UUID/PID and heartbeat. Acquire with atomic mkdir. Existing lock means busy.
  Never automatically steal it based on age: stale owner requires operator-confirmed
  recovery after verifying the previous process is stopped. Assert ownership before
  each external write and stop on heartbeat/ownership loss. No lock recovery runs
  automatically in tests or the live validation command.

```js
const first = await acquireWorkerLock(dbPath);
await assert.rejects(acquireWorkerLock(dbPath), /busy/);
await first.assertOwned();
await first.release();
const second = await acquireWorkerLock(dbPath);
await second.release();
```

- [ ] Run failing tests, implement, then rerun execution and ledger tests.
- [ ] Check process interruption tests leave an inspectable lock and checkpoints,
  never concurrent execution. Commit `feat: persist publishing execution checkpoints`.

## Task 3: Native streaming Meta adapter and configuration

**Files:** create `scripts/instagram-client.mjs` and `.test.mjs`; extend
`scripts/publishing-config.mjs`, `.test.mjs`; modify `.env.example` with placeholders.

**Interfaces:** `createInstagramClient({token, version, fetchImpl, sleep, timeoutMs})`
returns `verifyAccount({pageId, accountId, username})`,
`createContainer({accountId, caption}) -> {id, uri}`,
`uploadVideo({uri, fileHandle, size})`, `getContainerStatus(containerId) -> {statusCode}`,
`publishContainer({accountId, containerId}) -> {id}`,
`getPublishedMedia(mediaId) -> {id, permalink}`. Errors expose only operation,
numeric provider code/subcode, HTTP status and ambiguity classification.

- [ ] Refresh official docs at the API checkpoint. Write failing fetch-injected tests
  for exact hosts/methods/body/header contracts, account mismatch, expired token,
  invalid JSON, 429/5xx GET retries, unexpected 3xx and hostile upload URI.

```js
assert.equal(new URL(request.url).hostname, 'graph.facebook.com');
assert.equal(request.options.redirect, 'error');
assert.equal(request.options.headers.Authorization, 'Bearer test-token');
assert.equal(JSON.stringify(capturedDiagnostic).includes('test-token'), false);
```

- [ ] Implement Page/account reads and fail unless IDs and username match. Use
  `Authorization` headers, not token query parameters. Require numeric IDs, a
  version matching `^v[0-9]+\\.[0-9]+$`, and a nonempty token without newlines.
- [ ] Create container with `media_type=REELS`, `upload_type=resumable`, caption.
  Accept upload URI only on `https://rupload.facebook.com`, with no credentials,
  unexpected port, fragment or unrecognized path. Disable redirects.
- [ ] Stream from an already-open validated MP4 file descriptor, with file size and
  offset headers, OAuth authorization and fetch duplex support. Hash using that same
  file descriptor; compare stat before/after hashing and fail on mutation. Retain
  the descriptor through upload; never reopen a user-replaceable pathname.
- [ ] GET retries: at most three attempts, 1s then 2s backoff; honor Retry-After up
  to 60s, otherwise leave work pending. Abort requests at a configured bounded timeout.
  No automatic POST retries. Distinguish explicit prepublication error from uncertain
  delivery; do not serialize raw provider errors, URLs with secrets, or headers.
- [ ] Poll status once/minute, maximum five checks per invocation. Handle FINISHED,
  IN_PROGRESS, ERROR, EXPIRED and PUBLISHED explicitly; unknown values stop safely.
- [ ] Run adapter/config tests and inspect streaming memory behavior with a generated
  fixture. Commit `feat: add native Meta Reels streaming adapter`.

## Task 4: One-shot worker and crash reconciliation

**Files:** create `scripts/publishing-worker.mjs`, `.test.mjs`; integrate execution
and ledger interfaces from Tasks 1–3.

**Interface:** `runPublishingOnce({ledger, execution, lock, client, config, itemId, now})`
returns `{status, itemId?, containerId?, mediaId?, errorCode?}`. Config includes
`projectRoot, accountId, pageId, username`. Process at most the specified item.

- [ ] Write deterministic tests using temporary files/DBs, fake clock and fake client.
  Cover full success and exact operation order:

```js
assert.deepEqual(calls, ['verifyAccount', 'createContainer', 'uploadVideo',
  'getContainerStatus', 'publishContainer']);
assert.equal(ledger.getPublishingItem(id).state, 'published');
assert.equal(ledger.getPublishingItem(id).mediaId, 'media-1');
```

  Assert no client writes for wrong account, no approval, future schedule, changed
  caption/hash, missing file, symlink escape or already published item.
- [ ] Implement lock acquisition before account preflight and claim. Store attempt
  checkpoints before create/upload/publish calls, and external IDs immediately after
  successful responses. Never hold SQLite transactions across awaits.
- [ ] Implement recovery table:

| Durable phase | Next invocation |
| --- | --- |
| claimed | Revalidate artifact/approval snapshot; safe to create |
| create_requested without container ID | Unknown; do not recreate automatically |
| container_created before upload intent | Revalidate same artifact and upload |
| upload_requested or processing | Read same container; FINISHED can progress, IN_PROGRESS stays pending; never blindly resend bytes |
| publish_requested | Read-only reconciliation; never call media_publish again automatically |
| published | No-op |
| failed/unknown | No automatic writes |

  PUBLISHED without recoverable media ID becomes unknown with container ID. A clear
  prepublication processing error is safely failed. Uncertain publish outcomes remain
  unknown even after lease expiration. Preserve confirmed media ID if local persistence
  fails; recovery must not initiate another publication.
- [ ] Fault-inject termination at each checkpoint and after every successful response.
  Assert duplicate worker invocation cannot issue a second publish. Test status polling
  exhaustion retains processing rather than lying about failure or success.
- [ ] Run worker, execution, ledger and adapter tests. Commit
  `feat: publish approved Reels with conservative recovery`.

## Task 5: Explicit CLI, runbook and developer-safe defaults

**Files:** create `scripts/publishing-run.mjs`, `.test.mjs`,
`docs/native-instagram-publishing.md`; update package scripts and feature note.

**Interface:** CLI requires `--db`, `--project-root`, `--item`, and `--live` for
external writes. `--check-account` performs only account reads and does not open or
modify a ledger. Missing configuration exits nonzero with sanitized diagnostics.

- [ ] Write failing CLI tests: no args fails closed; no live flag never writes;
  check-account does not open DB; paths are explicit; invalid args rejected; output
  never contains token. Validate default shared App Support DB is not silently selected.
- [ ] Implement argument parsing and return-code mapping; load credentials through
  explicitly supplied Node `--env-file` or process environment, not repo discovery.
  Add `publishing:run` and `test:publishing` package scripts.

```json
{
  "publishing:run": "node scripts/publishing-run.mjs",
  "test:publishing": "node --test scripts/publishing-*.test.mjs scripts/instagram-client.test.mjs public/publishing/app.test.mjs"
}
```

- [ ] Document token scope/expiry, `600` file permissions, credential-free diagnostics,
  caption reapproval, pending/unknown distinction, lock recovery after process death,
  no automatic retry after uncertain writes, and exact launch commands for this CLI.
  Do not add unattended launch agents, cron jobs or service installers.
- [ ] Run `npm run test:publishing`, `npm run test:youtube`, `npm run lint`, and
  `git diff --check`. Report pre-existing failures separately. Commit
  `feat: expose explicit one-shot Instagram publishing command`.

## Task 6: Real Meta validation and documentation reconciliation

**Files:** add `docs/research/native-instagram-live-validation.md`; reconcile
`docs/features/native-instagram-publishing-worker.md` and the runbook.

- [ ] Obtain an explicitly supplied credential source for this worktree. Do not
  copy or change main's `.env`. Use a user-provided environment path read-only or a
  separate ignored owner-only credential file. Never print credentials.
- [ ] Run `--check-account` against Meta and record sanitized observed IDs/version/time.
  Recheck validity if authentication fails; do not automatically broaden permissions.
- [ ] Choose one non-sensitive local MP4 in this worktree, or ask the user for one.
  Verify media properties against current Meta docs using ffprobe. Show the preview,
  exact caption, account and due time; obtain that item's explicit approval in the UI.
  Use a new isolated live-test DB, never main's publishing database. Configure a
  separate loopback UI port so the existing approval server stays untouched.
- [ ] Run the CLI with that DB/root/item and `--live`. This is an actual upload/post,
  not a dry run. Log sanitized operation results, container ID and media ID; do not
  treat accepted upload as published. Stop on first uncertain outcome.
- [ ] Read the returned media ID/permalink from Meta and inspect the resulting Reel.
  Rerun for the same item; verify published state produces no second write. Keep the
  test post unless the user separately asks to remove it.
- [ ] Record real outcomes and any limitations. If the live test cannot finish,
  report the exact blocker and keep implementation-reconciled false; do not claim
  end-to-end completion from unit tests alone.
- [ ] Invoke feature-flow-diagrams RECONCILE; update diagrams and deviations, then
  mark COMPLETE only when implementation and live evidence support it. Run
  `npm run verify:feature-docs`, focused/full tests, lint and diff check again.
- [ ] Commit only intended code/docs, never credentials, MP4s or live DBs. Final handoff
  lists branch, absolute worktree, commits, tests, live media ID/link and remaining gaps.

## Plan self-review

All seven approved points map to Tasks 1–6. Direct upload replaces R2; UI redesign
stays deferred. Real publishing is explicit in Task 6, not replaced by mocks. Crash
recovery, caption races, file replacement, hostile redirects and exclusive ownership
have owning tests. Conservative lock recovery avoids unsafe lease stealing. No main
checkout writes or automatic credential copying are planned. Implementation has not
started; plan review and inline execution selection precede Task 1.
