# Single-run worker observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every single-URL Audiogram job independently diagnosable by job ID, with stage-level events, retained local process streams, precise MCP failures, and explicit linked retries.

**Architecture:** Keep the MCP server, local runner, detached worker, stable CLI contract, and single-URL pipeline as separate ports/adapters. A per-job diagnostic directory stores allowlisted JSONL events and separately bounded stdout/stderr files; SQLite stores safe job summaries and retry relationships. The pipeline emits stage events into that per-job logger, and MCP exposes only safe structured summaries plus a consent-gated retry operation.

**Tech Stack:** Node.js 22 ESM, built-in `node:sqlite`, `node:test`, MCP TypeScript SDK already used by the plugin, Zod, existing `pipeline-logger.mjs` and Audiograms pipeline interfaces.

**Spec:** `docs/superpowers/specs/2026-10-04-single-run-worker-observability-design.md`

## Global Constraints

- Each execution attempt has one UUID `jobId`; it is also the structured event `runId`.
- Logs remain under the local Audiograms data boundary; do not upload logs or add cloud dependencies.
- Create directories with owner-only permissions (0700) and log files with owner-only permissions (0600), subject to platform support.
- Keep worker and pipeline stdout/stderr in separate bounded files with configurable per-file size caps and a documented retention window.
- Do not store transcript/caption text, credentials, full provider payloads, arbitrary exception messages, or source URL query secrets in structured event fields.
- Local lookup returns safe structured events only; never print raw output or log tails.
- MCP returns only bounded, sanitized stage/error summaries and never raw local paths or raw process output.
- Retry is an explicit user decision, uses a dedicated `retry_audiogram({jobId})` tool, creates a new job UUID, and stores `retryOfJobId`.
- Preserve every failed stage/package in `failures[]`; use `partial` only if at least one verified artifact exists, otherwise use `failed`.
- Jev is a distinct stage; record its actual outcome and never synthesize a skipped event as a failure.
- Logger/file-write failure must not mask the actual processing result.
- Preserve the existing transcript-LLM selector default, provider configuration, local artifact boundary, and no-publish behavior.

## Review Focus

- Concurrent runs must never mix their JSONL events or process output; test two distinct job IDs writing in parallel in Task 1.
- Old SQLite databases must migrate without losing jobs, active-job deduplication, or status reads; test opening a pre-change schema in Task 2.
- Secret-bearing errors and transcript content must not appear in MCP payloads or JSONL; assert redaction and allowlisting in Tasks 1, 3, and 5.
- A failed render with at least one verified MP4 must become `partial`, while a run with no verified MP4 remains `failed`; test both in Task 3.
- Retry requests for unknown, running, or non-retryable jobs must not dispatch a worker; test the eligibility boundaries in Tasks 2 and 5.

---

### Task 1: Add isolated per-job diagnostic files and event reader

**Files:**
- Create: `plugins/audiogram-helper/job-diagnostics.mjs`
- Create: `plugins/audiogram-helper/job-diagnostics.test.mjs`
- Modify: `scripts/pipeline-logger.mjs`
- Modify: `scripts/pipeline-logger.test.mjs`

**Interfaces:**
- Produces `createJobDiagnostics({ projectRoot, jobId, maxFileBytes, retentionDays, now })`, returning `{ directory, eventLogPath, workerStdoutPath, workerStderrPath, pipelineStdoutPath, pipelineStderrPath, logger, readEvents }`.
- `logger.event(event)` injects both `jobId` and `runId: jobId`, then delegates allowlisting and best-effort append to `createPipelineLogger`.
- `readEvents({ limit })` reads only this job's JSONL file and returns validated structured events; it never reads process output.
- Adds `jobId` to the logger's identifier allowlist. No arbitrary payload fields are added.

- [ ] **Step 1: Write failing isolation, allowlist, permissions, and lookup tests**

In `plugins/audiogram-helper/job-diagnostics.test.mjs`, create two diagnostics contexts under a temporary project root with distinct UUIDs; concurrently append render events and assert each reader sees only its own `jobId`/`runId`. Also assert directory mode 0700, file mode 0600, invalid UUID rejection, and exclusion of `transcript`, `message`, and credential-like fields.

- [ ] **Step 2: Run focused tests and confirm the missing interface fails**

Run: `node --test plugins/audiogram-helper/job-diagnostics.test.mjs scripts/pipeline-logger.test.mjs`

Expected: FAIL because `job-diagnostics.mjs` and the logger `jobId` allowlist entry do not exist.

- [ ] **Step 3: Implement the per-job diagnostic context**

Create `.local/audiogram-helper/runs/<jobId>/` with owner-only permissions and define the five fixed filenames in one module. Validate UUIDs before deriving paths. Use the existing best-effort JSONL logger, injecting `jobId` and `runId` after caller metadata so callers cannot override them. Return structured events only from `readEvents`; never return raw stdout/stderr contents.

- [ ] **Step 4: Re-run focused tests**

Run: `node --test plugins/audiogram-helper/job-diagnostics.test.mjs scripts/pipeline-logger.test.mjs`

Expected: PASS, including two concurrent runs with no cross-run records and owner-only permissions on supported platforms.

### Task 2: Persist failure summaries and retry lineage in the job store

**Files:**
- Modify: `plugins/audiogram-helper/job-store.mjs`
- Modify: `plugins/audiogram-helper/server.test.mjs`

**Interfaces:**
- Extend `createOrGetJob({ videoId, sourceUrl })` to preserve current active-video deduplication behavior.
- Add `createRetryJob({ priorJobId })`, which accepts only an existing terminal `failed` or `partial` job and creates a fresh UUID with the prior canonical URL and `retryOfJobId`.
- Extend decoded jobs with `retryOfJobId` and structured `failures` from the result JSON while preserving existing `getJob`, `setResult`, and `setFailed` calls.
- Permit terminal statuses `complete`, `no_clips`, `failed`, and `partial`; keep queued/running transitions unchanged.

- [ ] **Step 1: Add migration and retry-link tests**

Add tests that initialize the existing pre-change `jobs` schema and rows, reopen it with the updated store, and assert prior data remains readable. Add tests that `createRetryJob` creates a distinct ID, copies the same source URL/video ID, links `retryOfJobId`, and rejects missing, queued, running, and complete prior jobs.

- [ ] **Step 2: Run the plugin test file and confirm the new tests fail**

Run: `node --test plugins/audiogram-helper/server.test.mjs`

Expected: FAIL only on the new migration/retry assertions.

- [ ] **Step 3: Add an idempotent SQLite schema migration**

Add nullable `retry_of_job_id` to existing databases using a schema-version check or `PRAGMA table_info(jobs)` before `ALTER TABLE`. Keep prior rows unchanged. Implement `createRetryJob` so eligibility validation and insertion happen transactionally; return `{ job, created: true }` and persist `retry_of_job_id`.

- [ ] **Step 4: Run store/plugin tests**

Run: `node --test plugins/audiogram-helper/server.test.mjs`

Expected: PASS; existing active-job deduplication and status persistence remain unchanged.

### Task 3: Emit per-job stage events and stage-specific pipeline results

**Files:**
- Modify: `scripts/single-url-pipeline.mjs`
- Modify: `scripts/single-url-pipeline.test.mjs`
- Modify: `scripts/youtube-inbox-pipeline-core.mjs`
- Modify: `scripts/youtube-inbox-pipeline-core.test.mjs`
- Modify: `scripts/clip-processing-core.mjs`
- Modify: `scripts/clip-processing-core.test.mjs`

**Interfaces:**
- `runSingleUrlPipeline({ ..., dependencies: { onEvent } })` passes the event callback into core and clip-processing stages. The worker-created logger provides the fixed `jobId`/`runId`; pipeline code supplies only stage metadata.
- Core stage records use `transcript`, `selection`, and `jev`; processing stages use `assets` and `render`; artifact collection uses `artifact_verification`; single-URL intake/metadata uses `intake` and `metadata`.
- The CLI result keeps `contractVersion`, `source`, and `artifactPaths`; failures are represented by `failures: [{ stage, code, message }]`, and status is `partial` exactly when failures exist and at least one verified artifact exists, otherwise `failed`.

- [ ] **Step 1: Add failing event-order and failure-classification tests**

Extend the successful single-URL test to collect events and assert actual ordered stages for intake, metadata, transcript, selection, Jev, assets, render, and artifact verification. Extend transcript-error and mixed-render tests to assert exact failed stage, safe stable code, and status. Add an asset failure plus a multi-package case proving every failed package is preserved. Assert event records contain neither transcript cue text nor provider payloads.

- [ ] **Step 2: Run pipeline tests and confirm the new expectations fail**

Run: `node --test scripts/single-url-pipeline.test.mjs scripts/youtube-inbox-pipeline-core.test.mjs scripts/clip-processing-core.test.mjs`

Expected: FAIL because `onEvent` is not wired by the single-URL caller and failures remain generic.

- [ ] **Step 3: Thread the job logger through the real stage boundaries**

Pass `onEvent` to `syncAndAnalyzeInbox` and `processClipPackages`. Add `runLoggedStage` boundaries around URL intake, metadata retrieval/validation, and artifact verification. Ensure each stage records `started` followed by its true terminal result. Ensure Jev has its own stage event and error classification; do not emit a fabricated failed event for a skipped/non-invoked stage. Do not add source URLs, transcript text, captions, arbitrary exception messages, or provider payloads to structured event metadata.

- [ ] **Step 4: Return exact and pluralized safe failures**

Collect failure records from analyzed items and package/treatment failures with stable codes and sanitized messages. Determine verified artifact paths before terminal classification. Return `partial` only when the verified list is non-empty and `failures` is non-empty; return `failed` when failures exist without verified outputs. Preserve `no_clips` and `complete` semantics. Remove the generic “One or more analysis, asset, or render steps failed.” response.

- [ ] **Step 5: Run focused pipeline tests**

Run: `node --test scripts/single-url-pipeline.test.mjs scripts/youtube-inbox-pipeline-core.test.mjs scripts/clip-processing-core.test.mjs scripts/pipeline-logger.test.mjs`

Expected: PASS with accurate event order, multi-failure records, truthful partial results, and no sensitive payloads in JSONL.

### Task 4: Retain worker and CLI stdout/stderr in separate bounded files

**Files:**
- Modify: `plugins/audiogram-helper/local-runner.mjs`
- Modify: `plugins/audiogram-helper/job-worker.mjs`
- Modify: `plugins/audiogram-helper/server.test.mjs`
- Modify: `plugins/audiogram-helper/job-diagnostics.mjs`
- Modify: `plugins/audiogram-helper/job-diagnostics.test.mjs`

**Interfaces:**
- `createLocalRunner` receives a diagnostic-context factory and launches each worker with file descriptors for `worker.stdout.log` and `worker.stderr.log`, not `stdio: 'ignore'`.
- `runJobWorker({ ..., diagnosticsFactory, runCommand })` routes CLI stdout to a bounded contract buffer and `pipeline.stdout.log`, routes stderr to `pipeline.stderr.log`, and keeps the structured CLI contract parseable.
- Exceeding a configured cap truncates/halts further raw-file writes safely, continues draining child pipes, preserves the exit/result outcome, and sets `diagnosticsIncomplete: true` in the safe job result.

- [ ] **Step 1: Add tests proving all four stream files are written on success and failure**

Use injected child/command adapters to assert distinct worker stdout/stderr and pipeline stdout/stderr destinations. Simulate a nonzero CLI exit that includes both `stdout` and `stderr`; assert the job remains failed with its stage/code and that each stream is preserved separately. Simulate output beyond the configured cap and assert file sizes stay bounded and the job result marks diagnostics incomplete.

- [ ] **Step 2: Run plugin tests and confirm capture tests fail**

Run: `node --test plugins/audiogram-helper/job-diagnostics.test.mjs plugins/audiogram-helper/server.test.mjs`

Expected: FAIL because the current detached spawn ignores all streams and the worker uses a discarding/rejecting `execFile` path.

- [ ] **Step 3: Attach detached worker streams to per-job files**

Open the two outer stream files with mode 0600, pass their descriptors to `spawnProcess` as stdout/stderr while preserving `detached: true`, `shell: false`, and the argument array, then close the parent's descriptors after spawn. Keep worker-start errors classified and persisted without leaking local paths.

- [ ] **Step 4: Stream CLI output without losing the JSON contract**

Replace the default `execFile` capture with a spawn-based adapter that incrementally writes each stream through the bounded-file writer. Retain stdout only up to the contract buffer limit needed to parse the small JSON result; continue consuming the child stream after the raw-file cap. On nonzero exit, retain both streams and classify using the stage-aware contract when available, otherwise `WORKER_PROCESS_FAILED`.

- [ ] **Step 5: Re-run stream and worker tests**

Run: `node --test plugins/audiogram-helper/job-diagnostics.test.mjs plugins/audiogram-helper/server.test.mjs`

Expected: PASS; raw output files are separate and capped, and result persistence succeeds even when output exceeds the cap.

### Task 5: Expose safe status details and explicit MCP retry

**Files:**
- Modify: `plugins/audiogram-helper/server.mjs`
- Modify: `plugins/audiogram-helper/local-runner.mjs`
- Modify: `plugins/audiogram-helper/job-store.mjs`
- Modify: `plugins/audiogram-helper/server.test.mjs`
- Modify: `plugins/audiogram-helper/README.md`

**Interfaces:**
- `createLocalRunner` adds `retry({ jobId })`; it validates stored eligibility, creates the linked job, dispatches it through the same worker path, and returns the new job state.
- MCP adds `retry_audiogram({ jobId })`, documented as requiring explicit user confirmation before the tool is called.
- MCP `outputShape` adds `partial`, `failures[]`, `retryOfJobId`, and `diagnosticsIncomplete`; it continues returning only safe summaries and verified artifact paths.
- `get_audiogram_status` returns the original ID and precise failures without exposing event/raw-file paths.

- [ ] **Step 1: Add MCP contract and retry-boundary tests**

Update tool-list assertions to include `retry_audiogram`. Through a real MCP test client, assert failed status includes `jobId`, stage/code failures, and no raw paths or log contents. Assert calling retry on a valid failed job dispatches exactly one new job with a different ID and correct `retryOfJobId`; assert unknown, running, complete, and no-retryable jobs do not dispatch. Check the tool description tells ChatGPT to ask for explicit user approval before retry.

- [ ] **Step 2: Run plugin tests and confirm contract assertions fail**

Run: `node --test plugins/audiogram-helper/server.test.mjs`

Expected: FAIL because only create/status operations and the old output enum exist.

- [ ] **Step 3: Implement runner retry and safe failure serialization**

Use the transactional job-store retry method, create a new per-job diagnostic directory, spawn exactly one worker, and preserve the retry relationship in the job store/result. Status responses must use an explicit safe serializer rather than spreading raw stored data into MCP responses.

- [ ] **Step 4: Register the MCP tool and update usage guidance**

Register `retry_audiogram` with a UUID input and a clear confirmation requirement in its tool description. Update `get_audiogram_status` output schema and tool description to explain stage-level safe diagnostics and the job ID. Document all three operations without claiming raw log access from ChatGPT.

- [ ] **Step 5: Run plugin contract tests**

Run: `node --test plugins/audiogram-helper/server.test.mjs`

Expected: PASS; MCP only exposes sanitized structured results, and explicit retry links a new job to its prior attempt.

### Task 6: Add local structured-event lookup by job ID

**Files:**
- Create: `scripts/audiogram-job-logs.mjs`
- Create: `scripts/audiogram-job-logs.test.mjs`
- Modify: `package.json`
- Modify: `plugins/audiogram-helper/README.md`

**Interfaces:**
- Export `readJobDiagnostics({ projectRoot, jobId, limit })` from the diagnostics module; it returns the validated safe events for exactly one UUID or a not-found result.
- Add `npm run audiogram:logs -- --job-id <UUID>` as an operator command that prints structured JSON events only. It must not print raw stream contents or filesystem paths.

- [ ] **Step 1: Add lookup tests for valid, missing, malformed, and cross-job IDs**

Create two job directories with distinct events. Assert the selected ID yields only its events; a missing valid UUID yields a clear not-found result; malformed UUID input exits nonzero; no output contains a raw log path, source URL, transcript text, or stream contents.

- [ ] **Step 2: Run lookup tests and verify they fail before implementation**

Run: `node --test scripts/audiogram-job-logs.test.mjs`

Expected: FAIL because the command and exported lookup do not yet exist.

- [ ] **Step 3: Implement the UUID-filtered structured-event command**

Parse only `--job-id` and optional bounded `--limit`; validate both before touching the filesystem. Read through the diagnostics module and serialize events as JSON lines. Return exit status 1 for invalid input or storage errors, and a nonzero/not-found indication for an unknown ID without scanning other job directories.

- [ ] **Step 4: Add the package script and local instructions**

Add `audiogram:logs` to `package.json`. Document that local operator lookup returns structured events only; worker and pipeline raw streams remain separate, private files and are not displayed by this command or sent through MCP.

- [ ] **Step 5: Run lookup tests**

Run: `node --test scripts/audiogram-job-logs.test.mjs`

Expected: PASS; lookup is scoped to one UUID and emits safe structured records only.

### Task 7: Reconcile the feature-flow note and run acceptance verification

**Files:**
- Modify: `docs/features/single-run-worker-observability.md`
- Modify: `docs/superpowers/specs/2026-10-04-single-run-worker-observability-design.md` only if implementation reveals an intentional deviation
- Test: `plugins/audiogram-helper/job-diagnostics.test.mjs`
- Test: `plugins/audiogram-helper/server.test.mjs`
- Test: `scripts/audiogram-job-logs.test.mjs`
- Test: `scripts/single-url-pipeline.test.mjs`
- Test: `scripts/youtube-inbox-pipeline-core.test.mjs`
- Test: `scripts/clip-processing-core.test.mjs`

**Interfaces:**
- Actual lifecycle, event flow, result schema, retry boundary, local lookup, privacy, and retention behavior must match the approved spec or be documented as an intentional deviation.

- [ ] **Step 1: Update diagrams and reconciliation from actual implementation**

Update the Mermaid flow and lifecycle diagrams for per-job files, partial status, dedicated retry, and local event lookup. Add an implementation reconciliation section describing actual behavior and deviations. Set frontmatter to `status: COMPLETE`, `design-reviewed: true`, and `implementation-reconciled: true` only after code and tests match the note.

- [ ] **Step 2: Run focused acceptance tests**

Run: `node --test plugins/audiogram-helper/job-diagnostics.test.mjs plugins/audiogram-helper/server.test.mjs scripts/audiogram-job-logs.test.mjs scripts/single-url-pipeline.test.mjs scripts/youtube-inbox-pipeline-core.test.mjs scripts/clip-processing-core.test.mjs scripts/pipeline-logger.test.mjs`

Expected: PASS; confirms run isolation, old-store migration, process capture/caps, truthful stage results, retry lineage and consent documentation, and structured-only local lookup.

- [ ] **Step 3: Run repository-wide feature-doc gate and relevant suites**

Run: `npm run verify:feature-docs`

Expected: PASS for all feature notes. Also run `npm run test:audiogram-plugin` and `npm run test:youtube` to detect integration regressions.

- [ ] **Step 4: Review final diff for privacy and scope**

Run: `git diff --check` and inspect `git diff -- plugins/audiogram-helper scripts package.json docs/features/single-run-worker-observability.md docs/superpowers/specs/2026-10-04-single-run-worker-observability-design.md`.

Expected: no whitespace errors, unrelated worktree files unchanged, and no secrets/transcripts/raw log data or external upload behavior introduced.
