# Controlled Instagram Recovery Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task, inline. Do not dispatch subagents by default. Steps use checkboxes for tracking.

**Goal:** Recover confirmed pre-publication upload failures through fresh approval, while preserving visible failure history and refusing ambiguous retries.

**Architecture:** Separate read-only inspection, pure eligibility classification, and transactional local recovery. Reuse the worker lock and Meta client. Extend the dashboard with bounded sanitized attempt history; leave publication to the existing worker.

**Tech Stack:** Existing Node.js ESM, node:sqlite, node:test, browser JavaScript, and Meta client. No new dependency.

**Spec:** docs/features/instagram-controlled-recovery.md

## Global Constraints

- Recovery never publishes, uploads, creates containers, or preserves approval.
- Old attempts and diagnostic evidence remain available after recovery.
- No automatic retry loop or manual SQL repair is part of the supported flow.
- Read-only inspection remains usable without initializing write-capable stores.
- Work inline. Preserve unrelated files. Commit each tested slice separately.
- Do not switch branches or create worktrees without resolving workspace choice with the user.
- Live recovery and publication require separate explicit authorization.

## Review Focus

- Legacy upload_requested attempts lack failed state: cover in Tasks 2 and 3.
- Caption or artifact changes during Meta reads: stale fingerprint rejected in Task 3.
- Expired/inaccessible container: blocked, not assumed failed, in Tasks 1 and 2.
- Old failure disappears after new attempt: cross-attempt history covered in Task 5.
- Diagnostic/audit insertion fails: full rollback covered in Task 3.

## File responsibilities

- Create scripts/publishing-recovery.mjs and .test.mjs: eligibility and inspection orchestration.
- Create scripts/publishing-recovery-store.mjs and .test.mjs: read-only snapshot and atomic recovery persistence.
- Create scripts/publishing-recover.mjs and .test.mjs: explicit inspect/apply command.
- Modify scripts/publishing-execution.mjs and its tests: audited replacement attempt eligibility.
- Modify scripts/publishing-server.mjs and its tests: bounded sanitized history response.
- Modify public/publishing/app.js and app.test.mjs: visible prior failures.
- Modify scripts/publishing-worker.mjs only to share existing artifact validation without changing publishing behavior; extract scripts/publishing-artifact.mjs if required.
- Update docs/features/instagram-controlled-recovery.md with research, reconciliation, and operational commands.

## Task 1: Establish provider evidence and execution workspace

- [ ] Verify pwd -P, git rev-parse --show-toplevel, status, worktrees, and current remote main. Stop on a my-video-2 filesystem root. Ask before switching or creating a worktree. The planning checkout is codex/template-sample-server; do not mix recovery commits into it.
- [ ] Read the Context7 skill; resolve Instagram API documentation and query for resumable container creation, lost create responses, idempotency, container lookup without ID, expiration, and detailed upload status. Verify against official Meta documentation, including https://developers.facebook.com/documentation/instagram-platform/content-publishing.
- [ ] Record exact source links, date, supported guarantees, and unresolved questions in the feature note. No live POSTs or secret output. If no documented reconciliation exists, retain unknown; do not implement speculative search.
- [ ] Derive a narrow eligibility fixture from the sanitized confirmed upload failure. Provider code alone is insufficient; require phase and publication evidence as well. If fresh provider semantics contradict the approved design, stop for review.
- [ ] Run npm run verify:feature-docs; commit the approved design, plan, and sourced findings on the agreed recovery branch.

## Task 2: Read-only inspection and eligibility

**Interfaces:** inspectRecovery({store, client, config, itemId, verifyArtifact}) returns {eligible, reasonCode, expected, diagnostic}. expected contains itemId, attemptId, containerId, and a fingerprint of recovery-relevant persisted fields. classifyRecovery(snapshot, diagnostic) is pure. store.readSnapshot(itemId) uses an existing database opened readOnly, with no migration.

- [ ] Write table-driven failing tests for confirmed upload error, legacy active attempt, pending, FINISHED, PUBLISHED, processing-only error, missing ID, unknown/create_requested/publish_requested phases, media ID present, account mismatch, missing approval, and contradictory evidence.

```js
for (const statusCode of ['FINISHED', 'PUBLISHED']) {
  assert.equal(classifyRecovery(snapshot, {
    statusCode, uploadPhase: 'error'
  }).eligible, false);
}
```

- [ ] Add tests that missing database paths are not created, old schemas are reported without alteration, tokens are absent from outputs, and missing/changed/symlink artifacts fail validation. Use temporary fixture databases, not the live ledger.
- [ ] Run node --test scripts/publishing-recovery.test.mjs scripts/publishing-recovery-store.test.mjs and confirm the new tests fail for missing behavior.
- [ ] Implement read-only snapshots; reuse existing account/status GET methods and extract the worker's artifact verification if needed. Close every handle. The command must not call createPublishingExecution or createPublishingLedger during inspection because they initialize schema.
- [ ] Run the new tests plus scripts/publishing-worker.test.mjs; commit feat: inspect Instagram upload recovery eligibility.

## Task 3: Atomic audited return to queue

**Interfaces:** store.applyRecovery({expected, diagnostic, reasonCode}) returns {status:'queued_for_reapproval', itemId, recoveryId}. Called only under the worker lock after fresh inspection. Store a unique audit entry keyed by old attempt ID, with container ID, observation time, reason, and sanitized evidence. Preserve old attempts unchanged except terminal failure classification where required.

- [ ] Write failing transaction tests for legacy active attempts and failed attempts. Require cleared approval/schedule/active container fields, retained caption/artifact/account, retained old container in attempt history, and a recovery audit entry.
- [ ] Test stale attempt, changed caption/hash/account/state, duplicate apply, publication intent, and recorded media ID. Inject an audit INSERT failure with a SQLite trigger:

```sql
CREATE TRIGGER reject_recovery BEFORE INSERT ON publishing_recoveries
BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END;
```

- [ ] Assert every item/attempt field is unchanged after that failure. Run the store tests and observe failures before implementation.
- [ ] Implement BEGIN IMMEDIATE transaction, expected fingerprint comparison, eligibility revalidation, terminal classification, audit INSERT, and requeue. Keep safe_to_retry false for recovered failure; authorize replacement through the unique recovery audit, not broadening generic retry classification.
- [ ] Extend beginAttempt to permit a freshly approved/claimed item whose latest failed attempt has an unused recovery audit. Associate/consume that authorization atomically when inserting the replacement attempt. Preserve existing confirmed-safe failure behavior. Test two begin calls cannot create two replacements.
- [ ] Run node --test scripts/publishing-recovery-store.test.mjs scripts/publishing-execution.test.mjs scripts/publishing-ledger.test.mjs; commit feat: atomically requeue confirmed upload failures for approval.

## Task 4: Explicit recovery command and replacement worker test

**Interface:** publishing-recover.mjs --item ID defaults to inspection. Apply additionally requires --apply --expected-attempt ID --expected-container ID. Optional --db and --project-root must be absolute. Resolve storage and credentials through existing config; never print credentials.

- [ ] Test malformed/duplicate options, missing expected identifiers, lock contention, ownership loss, stale inspection, provider read failure, and repeated apply. Use injected clients whose create/upload/publish methods throw if called.

```js
const forbidden = () => { throw new Error('external write forbidden'); };
const client = { createContainer: forbidden, uploadVideo: forbidden,
  publish: forbidden, verifyAccount, getContainerStatus };
```

- [ ] Run node --test scripts/publishing-recover.test.mjs; confirm failures before adding the CLI.
- [ ] Implement apply: acquire worker lock, inspect afresh, match expected IDs, assert lock ownership, then call the atomic store method. Release resources in finally. Emit only sanitized structured outcomes. Inspection must not acquire a write lock or alter database schema.
- [ ] Add an integration test: recover -> worker cannot publish queued item -> approve through existing ledger method -> worker creates a new container -> succeeds with fake Meta responses. Assert the old container remains in history and never receives another upload.
- [ ] Run npm run test:publishing; commit feat: add explicit Instagram recovery command.

## Task 5: Durable dashboard failure history

**Interface:** GET /api/items/:id/history returns a bounded list (latest 20 attempts) with attempt ID/time, safe outcome label, sanitized code, and recovery timestamp; never upload_uri or raw provider messages. Read history without schema initialization. Missing older history tables yield an empty list, not a server crash.

- [ ] Write server tests for bounds, nonexistent item, historical failed attempt after reapproval/new attempt, missing legacy tables, and secret omission. Write UI tests for current Queued state plus previous upload failure, creation unknown, processing pending, and publish unknown.
- [ ] Run node --test scripts/publishing-server.test.mjs public/publishing/app.test.mjs; observe failures.
- [ ] Implement the read endpoint and UI rendering using textContent for provider-derived labels/codes. A history-fetch failure must not hide approval controls or falsely show a clean history. Do not add a recovery button.
- [ ] Verify browser display with fixture data: queued item and previous failure both visible. Run the targeted tests; commit feat: show previous Instagram publishing failures in queue.

## Task 6: Full verification and handoff

- [ ] Run npm run test:publishing, npm run test:youtube, npm run lint, npm run verify:feature-docs, and git diff --check. Record actual counts and failures; do not bypass hooks.
- [ ] Review changes inline against every invariant; verify inspection has zero write-capable database initialization and recovery has zero Meta writes.
- [ ] Reconcile the feature note against code; set COMPLETE and implementation-reconciled true only after tests and review pass. Include exact operator commands and blocked conditions. Commit docs: reconcile controlled recovery behavior.
- [ ] Report branch, worktree, commits, tests, provider investigation result, and remaining limitations. Do not create/merge a PR or run live recovery without authorization.
- [ ] For later explicitly authorized live validation: inspect the target item with fresh GETs, report eligibility, apply recovery, ask the user to approve in the UI, then separately invoke the item-scoped publishing worker when authorized.
