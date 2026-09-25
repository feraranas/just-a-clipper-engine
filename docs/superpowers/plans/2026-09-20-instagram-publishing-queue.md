# Instagram Publishing Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local approval queue and scheduled publisher for explicitly approved Remotion MP4 artifacts on Instagram.

**Architecture:** Extend the existing SQLite-backed artifact workflow with a publishing ledger. Serve a local vanilla HTML approval page from a Node standard-library server, then run a separate publisher that uploads approved artifacts to Cloudflare R2 and publishes them through the Instagram Graph API.

**Tech Stack:** Node.js ESM, SQLite via the repository’s existing ledger approach, vanilla HTML/CSS/JavaScript, Cloudflare R2 S3-compatible storage, Instagram Graph API, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-20-instagram-publishing-queue-design.md`

## Global Constraints

- Approval is a hard gate; rendering alone never authorizes publication.
- Use one Instagram Professional account in V1.
- Schedule daily at 18:00 in `America/Mexico_City`; persist timestamps in UTC.
- Use Cloudflare R2; retain successful uploaded objects for 7 days and failed/unknown objects for 30 days.
- Serve only validated repository-relative artifact paths.
- Never automatically retry an ambiguous publish result.
- Do not modify the existing Remotion rendering behavior.
- Preserve local rendered artifacts; cleanup applies only to temporary uploaded objects.

## File Map

- Create `scripts/publishing-ledger.mjs` — SQLite schema and state transitions.
- Create `scripts/publishing-ledger.test.mjs` — isolated ledger tests.
- Create `scripts/publishing-server.mjs` — local HTTP routes and static preview serving.
- Create `scripts/publishing-server.test.mjs` — route and path-safety tests.
- Create `scripts/instagram-client.mjs` — Meta API adapter.
- Create `scripts/instagram-client.test.mjs` — mocked API behavior tests.
- Create `scripts/r2-media-store.mjs` — R2 upload, public URL, and cleanup adapter.
- Create `scripts/r2-media-store.test.mjs` — mocked storage tests.
- Create `scripts/publishing-worker.mjs` — scheduled selection and orchestration.
- Create `scripts/publishing-worker.test.mjs` — state-machine and recovery tests.
- Create `public/publishing/index.html` — queue markup.
- Create `public/publishing/app.js` — queue interactions.
- Create `public/publishing/styles.css` — local queue styling.
- Modify `scripts/treatment-runner.mjs` or the narrow artifact-completion boundary identified during implementation — enqueue validated artifacts without changing render semantics.
- Modify `package.json` — add local server, worker, and focused test scripts plus only required dependencies.
- Modify `.gitignore` if required — exclude local publishing database and generated temporary files.

### Task 1: Add the publishing ledger and state machine

**Interfaces:** `createPublishingLedger(dbPath)`, `enqueueArtifact(input)`, `getQueue(filters)`, `getPublishingItem(id)`, `updateCaption(id, caption)`, `approveItem(id, scheduledAt)`, `rejectItem(id, reason)`, `claimDueApprovedItem(now)`, `transitionItem(id, fromState, toState, patch)`, and `recordUnknownOutcome(id, details)`.

- [ ] Write tests for enqueueing, approval, rejection, caption updates, hash mismatch detection, due-item claiming, and invalid transitions.
- [ ] Run `node --test scripts/publishing-ledger.test.mjs` and verify the new tests fail before implementation.
- [ ] Implement a focused schema with the required artifact, caption, approval, scheduling, external-ID, error, and timestamp fields.
- [ ] Implement explicit transitions for `queued`, `approved`, `rejected`, `uploading`, `container_created`, `processing`, `published`, `failed`, and `unknown`.
- [ ] Ensure claiming is atomic so two worker invocations cannot claim the same item.
- [ ] Run the focused ledger tests and then `npm run test:youtube`.
- [ ] Commit the ledger independently.

### Task 2: Enqueue validated Remotion artifacts

**Interfaces:** `enqueueArtifact()` from Task 1; an artifact-completion hook that receives the project-relative MP4 path, content hash, source metadata, title, and default caption.

- [ ] Locate the existing artifact completion boundary and add tests showing a completed artifact creates one queued publishing record.
- [ ] Verify rerunning the completion path for the same artifact hash is idempotent.
- [ ] Implement the narrow enqueue call without changing acquisition or rendering behavior.
- [ ] Reject missing, empty, non-MP4, and outside-repository paths before enqueueing.
- [ ] Run the focused tests and the existing artifact/treatment tests.
- [ ] Commit the enqueue integration.

### Task 3: Build the local approval server

**Interfaces:** HTTP routes for queue listing, item detail, caption update, approval, rejection, schedule update, safe retry, and unknown-outcome verification.

- [ ] Write route tests using a temporary database and fixture MP4; cover queue display, caption persistence, approval, rejection, and path traversal rejection.
- [ ] Run the focused server tests and verify they fail.
- [ ] Implement the Node standard-library HTTP server with JSON endpoints and static files from `public/publishing`.
- [ ] Resolve preview paths only from validated project-relative artifact paths.
- [ ] Implement state-aware actions so published and unknown records cannot be casually re-approved or retried.
- [ ] Run the focused server tests.
- [ ] Commit the local server API.

### Task 4: Add the approval queue frontend

**Interfaces:** browser calls to the Task 3 HTTP endpoints; HTML video preview for each artifact.

- [ ] Add a fixture-driven browser-independent rendering test or HTML contract test for required controls and state labels.
- [ ] Create queue markup with grouped states, inline video previews, caption editor, schedule input, and explicit approve/reject buttons.
- [ ] Add client-side fetch actions with visible success and error feedback.
- [ ] Add a confirmation step for approval and rejection; do not hide the scheduled time.
- [ ] Add styles for readable local use without introducing a frontend framework.
- [ ] Run the server and manually verify a fixture queue item in a browser.
- [ ] Commit the approval UI.

### Task 5: Implement the Cloudflare R2 media adapter

**Interfaces:** `putTemporaryMedia({localPath, objectKey, expiresAt})`, `getPublicMediaUrl(objectKey)`, and `deleteTemporaryMedia(objectKey)`.

- [ ] Add mocked tests for upload success, upload failure, deterministic object keys, and cleanup retention decisions.
- [ ] Run the focused tests and verify they fail.
- [ ] Add the minimal S3-compatible dependency required for R2 and read credentials only from environment variables.
- [ ] Implement temporary object keys containing publishing ID and artifact hash, never user-provided path fragments.
- [ ] Implement retention policy: 7 days for published objects and 30 days for failed/unknown objects.
- [ ] Run focused tests without contacting R2.
- [ ] Commit the storage adapter.

### Task 6: Implement the Instagram Graph API adapter

**Interfaces:** `createContainer({igUserId, videoUrl, caption, accessToken})`, `getContainerStatus(containerId)`, `publishContainer({igUserId, containerId, accessToken})`, and `verifyPublication({igUserId, containerId, accessToken})`.

- [ ] Add mocked HTTP tests for container creation, status polling values, successful publishing, clear API errors, and network timeouts.
- [ ] Run the focused tests and verify they fail.
- [ ] Implement the adapter with access tokens and account IDs read only from environment variables.
- [ ] Preserve external IDs and response bodies needed for operator diagnosis without logging access tokens.
- [ ] Map a timeout during `media_publish` to an unknown outcome rather than a retryable failure.
- [ ] Run focused tests without contacting Meta.
- [ ] Commit the Instagram adapter.

### Task 7: Implement the scheduled publishing worker

**Interfaces:** `runPublishingOnce({now, dependencies})`, `publishOne(item, dependencies)`, and a CLI entry point for manual invocation.

- [ ] Write orchestration tests for success, artifact hash mismatch, R2 failure, container processing failure, clear publish failure, unknown publish outcome, and second-run idempotency.
- [ ] Run the focused tests and verify they fail.
- [ ] Implement one-item-at-a-time processing: claim, validate, upload, create container, poll status, publish, record ID, and schedule cleanup.
- [ ] Ensure a published item is never selected again.
- [ ] Ensure unknown items require explicit verification before retry.
- [ ] Add the daily schedule configuration with `America/Mexico_City` as the default and UTC persistence.
- [ ] Run focused tests and all existing repository tests.
- [ ] Commit the worker.

### Task 8: Add local commands and documentation

**Interfaces:** package scripts for starting the approval server, running the worker once, and running publishing tests.

- [ ] Add `publishing:server`, `publishing:run`, and `test:publishing` scripts.
- [ ] Document environment variables, R2 setup, Meta account confirmation, local server startup, approval flow, schedule configuration, and unknown-outcome recovery.
- [ ] Document the direct real-account smoke test and its one-item limit.
- [ ] Run `npm run lint`, `npm run test:youtube`, and `npm run test:publishing`.
- [ ] Commit commands and documentation.

### Task 9: Perform the live one-Reel smoke test

**Interfaces:** the completed local queue, R2 adapter, Instagram adapter, and worker.

- [ ] Confirm the account is Professional and the required Meta permissions are available.
- [ ] Start the local approval server and verify one real rendered artifact previews correctly.
- [ ] Approve exactly one short Reel with the selected caption and schedule.
- [ ] Run the worker manually, observe container processing, and verify the Reel appears on the account.
- [ ] Verify the Instagram media ID is stored in SQLite.
- [ ] Run the worker again and verify no duplicate publication occurs.
- [ ] Inspect logs for leaked credentials and verify the temporary object retention state.
- [ ] Record the exact live result; do not claim success if any step lacks a visible result.

## Plan self-review

- Ledger, queue UI, storage, Meta API, worker, scheduling, and live verification each have an explicit task.
- No task changes Remotion rendering semantics.
- Ambiguous external outcomes are represented and never automatically retried.
- Every task has focused tests before implementation and a separate commit boundary.
- No unresolved implementation placeholder is required; provider, UI style, schedule, account, and smoke-test decisions are fixed by the approved spec.
