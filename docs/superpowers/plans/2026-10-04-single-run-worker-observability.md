# Single-run worker observability implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Complete each task in order. Mark each step with a checkbox.

**Goal:** Give each single-URL job a separate diagnostic record, exact stage failures, local process logs, and an explicit retry path.

**Architecture:** Keep the MCP server, local runner, worker, CLI contract, and pipeline as separate components. Store safe JSONL events and bounded process logs in a directory for each job. Store safe job results and retry links in SQLite.

**Tech Stack:** Node.js 22 ESM, built-in `node:sqlite`, `node:test`, the existing MCP SDK, Zod, and the current Audiograms pipeline modules.

**Spec:** `docs/superpowers/specs/2026-10-04-single-run-worker-observability-design.md`

## Global constraints

- Give each attempt one UUID named `jobId`. Use the same value for event `runId`.
- Store all logs under the local Audiograms data directory. Do not upload logs or add cloud services.
- Set diagnostic directory permissions to 0700 and file permissions to 0600 when the platform supports them.
- Store worker and pipeline stdout and stderr in separate bounded files.
- Add configurable file size limits and document the retention period.
- Keep transcript text, captions, credentials, provider payloads, raw exception text, and URL query secrets out of JSONL events.
- Make local lookup return safe structured events only. Do not print raw process output or file paths.
- Make MCP return bounded, sanitized failure details. Do not return raw output or local file paths.
- Retry only after the user agrees. Use `retry_audiogram({jobId})` and create a new linked job.
- List each failed stage or package in `failures[]`.
- Use `partial` only when at least one verified artifact exists. Otherwise use `failed`.
- Log Jev as a distinct stage. Do not report a skipped stage as a failure.
- Do not let a logging error replace the pipeline result.
- Keep the transcript-LLM default, provider setup, local artifacts, and no-publish behavior unchanged.

## Review focus

- Run two jobs at the same time. Check that their events and process logs stay separate. Test this in Task 1.
- Open a database that uses the old schema. Check that its jobs and active-job checks still work. Test this in Task 2.
- Add secrets and transcript text to test errors. Check that JSONL and MCP output exclude them. Test this in Tasks 1, 3, and 5.
- Fail one render after another render creates a valid MP4. Check that the result is `partial`. Test this in Task 3.
- Try to retry unknown, running, complete, and non-retryable jobs. Check that the runner does not start a worker. Test this in Tasks 2 and 5.

---

### Task 1: Create per-job diagnostic files

**Files:**
- Create `plugins/audiogram-helper/job-diagnostics.mjs`.
- Create `plugins/audiogram-helper/job-diagnostics.test.mjs`.
- Change `scripts/pipeline-logger.mjs`.
- Change `scripts/pipeline-logger.test.mjs`.

**Interfaces:**
- Add `createJobDiagnostics({projectRoot, jobId, maxFileBytes, retentionDays, now})`.
- Return the diagnostic directory, five file paths, a logger, and a `readEvents` function.
- The logger sets `jobId` and `runId` to the given job ID. Callers cannot override these values.
- `readEvents({limit})` returns safe events from that job only. It never reads process logs.
- Add `jobId` to the event allowlist. Do not add unrestricted event fields.

- [ ] **Step 1: Add tests for job isolation, fields, and permissions.**

Create two job contexts in a temporary directory. Append events to both contexts at the same time. Check that each reader returns only its job's events. Check directory and file permissions. Check invalid UUID handling. Check that events omit `transcript`, `message`, and credential fields.

- [ ] **Step 2: Run the focused tests.**

Run: `node --test plugins/audiogram-helper/job-diagnostics.test.mjs scripts/pipeline-logger.test.mjs`

Expected: The tests fail because the diagnostics module and `jobId` allowlist entry do not exist.

- [ ] **Step 3: Add the per-job diagnostic context.**

Create `.local/audiogram-helper/runs/<jobId>/`. Set directory mode to 0700 and file mode to 0600. Define all five file names in one module. Check each UUID before you create a path. Use the existing best-effort JSONL logger. Set `jobId` and `runId` after you read caller metadata. Return structured events only.

- [ ] **Step 4: Run the focused tests again.**

Run: `node --test plugins/audiogram-helper/job-diagnostics.test.mjs scripts/pipeline-logger.test.mjs`

Expected: All tests pass. Concurrent jobs have separate event files. Permission checks pass on supported platforms.

### Task 2: Store failures and retry links

**Files:**
- Change `plugins/audiogram-helper/job-store.mjs`.
- Change `plugins/audiogram-helper/server.test.mjs`.

**Interfaces:**
- Keep `createOrGetJob({videoId, sourceUrl})` and its active-job behavior.
- Add `createRetryJob({priorJobId})`.
- Allow retry only for terminal `failed` or `partial` jobs.
- Give the retry a new UUID. Copy the source URL and video ID. Store `retryOfJobId`.
- Add `retryOfJobId` and structured failures to decoded jobs.
- Support terminal states `complete`, `no_clips`, `failed`, and `partial`.

- [ ] **Step 1: Add database migration and retry tests.**

Create a database with the current schema and a saved job. Open it with the updated store. Check that the job remains readable. Test that a retry gets a new ID and keeps the source URL, video ID, and prior job ID. Reject missing, queued, running, and complete jobs.

- [ ] **Step 2: Run the plugin tests.**

Run: `node --test plugins/audiogram-helper/server.test.mjs`

Expected: The new migration and retry tests fail.

- [ ] **Step 3: Add an idempotent schema migration.**

Use a schema version or `PRAGMA table_info(jobs)` before you add `retry_of_job_id`. Keep existing rows unchanged. Check retry eligibility and insert the new job in one transaction. Return the new job and `created: true`.

- [ ] **Step 4: Run the plugin tests again.**

Run: `node --test plugins/audiogram-helper/server.test.mjs`

Expected: All tests pass. Active-job checks and saved job reads keep their current behavior.

### Task 3: Trace pipeline stages and return exact failures

**Files:**
- Change `scripts/single-url-pipeline.mjs` and its test file.
- Change `scripts/youtube-inbox-pipeline-core.mjs` and its test file.
- Change `scripts/clip-processing-core.mjs` and its test file.

**Interfaces:**
- Pass `dependencies.onEvent` from `runSingleUrlPipeline` to the pipeline core and clip processor.
- Use `intake`, `metadata`, `transcript`, `selection`, `jev`, `assets`, `render`, and `artifact_verification` stage names.
- Keep `contractVersion`, `source`, and `artifactPaths` in the CLI result.
- Return failures as `failures: [{stage, code, message}]`.
- Return `partial` only when failures exist and at least one artifact passes verification.
- Return `failed` when failures exist and no artifact passes verification.

- [ ] **Step 1: Add tests for stage order and failure details.**

Collect events in the successful pipeline test. Check the stage order from intake through artifact verification. Check transcript and render failures for the correct stage and code. Add asset and multi-package failures. Check that each failure appears in the result. Check that events contain no transcript text or provider payloads.

- [ ] **Step 2: Run the pipeline tests.**

Run: `node --test scripts/single-url-pipeline.test.mjs scripts/youtube-inbox-pipeline-core.test.mjs scripts/clip-processing-core.test.mjs`

Expected: The new event and failure tests fail. The caller does not pass `onEvent` yet. Failures still use a generic message.

- [ ] **Step 3: Pass the logger through each stage.**

Pass `onEvent` to `syncAndAnalyzeInbox` and `processClipPackages`. Use `runLoggedStage` for intake, metadata, and artifact verification. Record the true start and result for each stage. Give Jev its own stage event. Do not report a stage that did not run as failed. Do not include URLs, transcript text, captions, raw errors, or provider payloads in event fields.

- [ ] **Step 4: Return a failure for each failed stage or package.**

Collect safe failure details from analysis, asset, and render results. Check artifacts before you set the final status. Return `partial` when failures exist and verified artifacts exist. Return `failed` when failures exist and no verified artifacts exist. Keep `no_clips` and `complete` behavior. Remove the generic multi-stage failure message.

- [ ] **Step 5: Run the pipeline tests again.**

Run: `node --test scripts/single-url-pipeline.test.mjs scripts/youtube-inbox-pipeline-core.test.mjs scripts/clip-processing-core.test.mjs scripts/pipeline-logger.test.mjs`

Expected: All tests pass. Events show the real stage order. Results include each failure and the correct status.

### Task 4: Save bounded worker and pipeline output

**Files:**
- Change `plugins/audiogram-helper/local-runner.mjs`.
- Change `plugins/audiogram-helper/job-worker.mjs`.
- Change `plugins/audiogram-helper/server.test.mjs`.
- Change `plugins/audiogram-helper/job-diagnostics.mjs` and its test file.

**Interfaces:**
- Pass a diagnostic context to `createLocalRunner`.
- Send the worker's stdout and stderr to its two job files. Do not use `stdio: 'ignore'`.
- Add `diagnosticsFactory` to `runJobWorker`.
- Send CLI stdout to a bounded contract buffer and a separate file. Send CLI stderr to its own file.
- Continue reading child output after a log file reaches its size limit.
- Set `diagnosticsIncomplete: true` if the output exceeds a cap or a log write fails.

- [ ] **Step 1: Add tests for all four output files.**

Use test adapters for the worker and CLI process. Check that each process writes to the correct files. Simulate a nonzero CLI exit with stdout and stderr. Check that the job stays failed and keeps its stage and code. Exceed a file cap. Check the file size and `diagnosticsIncomplete` result.

- [ ] **Step 2: Run the plugin tests.**

Run: `node --test plugins/audiogram-helper/job-diagnostics.test.mjs plugins/audiogram-helper/server.test.mjs`

Expected: The capture tests fail. The runner currently ignores worker output. The worker currently uses `execFile`.

- [ ] **Step 3: Connect worker output files.**

Open the two worker files with mode 0600. Pass their file descriptors to the detached process. Keep `detached: true`, `shell: false`, and the current argument array. Close the parent file descriptors after spawn. Store worker start errors without exposing local paths.

- [ ] **Step 4: Stream CLI output and parse its result.**

Use `spawn` for the CLI process. Write each stream to its bounded file. Keep stdout in memory only up to the contract limit. Continue to drain both streams after a file reaches its cap. Parse the CLI JSON result. If the child exits with an error and no stage failure exists, use `WORKER_PROCESS_FAILED`.

- [ ] **Step 5: Run the plugin tests again.**

Run: `node --test plugins/audiogram-helper/job-diagnostics.test.mjs plugins/audiogram-helper/server.test.mjs`

Expected: All tests pass. Each stream has its own capped file. Result storage still works when a file reaches its cap.

### Task 5: Return safe status and add MCP retry

**Files:**
- Change `plugins/audiogram-helper/server.mjs`.
- Change `plugins/audiogram-helper/local-runner.mjs` and `job-store.mjs`.
- Change `plugins/audiogram-helper/server.test.mjs`.
- Change `plugins/audiogram-helper/README.md`.

**Interfaces:**
- Add `retry({jobId})` to the local runner.
- Add MCP tool `retry_audiogram({jobId})`.
- Tell ChatGPT to ask the user before it calls the retry tool.
- Add `partial`, `failures`, `retryOfJobId`, and `diagnosticsIncomplete` to the output schema.
- Keep local file paths and raw logs out of MCP results.

- [ ] **Step 1: Add MCP result and retry tests.**

Use the MCP test client. Check that the tool list includes `retry_audiogram`. Check that status includes the job ID and safe stage failures. Check that status omits raw paths and log contents. Retry one failed job. Check that one new job starts with a new ID and the correct prior ID. Check that unknown, running, complete, and non-retryable jobs do not start workers. Check the tool description says to ask the user first.

- [ ] **Step 2: Run the plugin tests.**

Run: `node --test plugins/audiogram-helper/server.test.mjs`

Expected: The new MCP and retry tests fail. The server only has create and status tools.

- [ ] **Step 3: Add safe runner results.**

Use the job store to create an eligible retry. Create a diagnostic directory for its new ID. Start one worker. Store `retryOfJobId`. Build status results from an explicit safe object. Do not copy raw database or error objects into MCP results.

- [ ] **Step 4: Add the MCP tool and update its guide.**

Register `retry_audiogram` with a UUID input. Its description must require user approval before the call. Update the status tool schema and description. Update the README to describe all three tools. Do not claim that ChatGPT can read raw logs.

- [ ] **Step 5: Run the plugin tests again.**

Run: `node --test plugins/audiogram-helper/server.test.mjs`

Expected: All tests pass. MCP returns safe results. Retry creates a linked job.

### Task 6: Add local event lookup

**Files:**
- Create `scripts/audiogram-job-logs.mjs` and its test file.
- Change `package.json`.
- Change `plugins/audiogram-helper/README.md`.

**Interfaces:**
- Export `readJobDiagnostics({projectRoot, jobId, limit})` from the diagnostics module.
- Read events for one UUID only. Return a not-found result when the UUID has no event file.
- Add `npm run audiogram:logs -- --job-id <UUID>`.
- Print JSON events only. Do not print file paths or process output.

- [ ] **Step 1: Add lookup tests.**

Create event files for two job IDs. Check that lookup returns events for only the selected ID. Check the not-found result for an unknown valid UUID. Check that an invalid UUID exits with an error. Check that output omits paths, URLs, transcripts, and raw streams.

- [ ] **Step 2: Run the lookup tests.**

Run: `node --test scripts/audiogram-job-logs.test.mjs`

Expected: The tests fail because the command and lookup function do not exist.

- [ ] **Step 3: Add the lookup command.**

Parse `--job-id` and an optional bounded `--limit`. Check both inputs before you read files. Use the diagnostics module to read one job. Print events as JSON lines. Return exit status 1 for invalid input or storage errors. Return a not-found result for an unknown ID. Do not scan other job directories.

- [ ] **Step 4: Add the package command and README notes.**

Add `audiogram:logs` to `package.json`. State that local lookup returns safe events only. State that raw streams remain private and do not appear in lookup or MCP output.

- [ ] **Step 5: Run the lookup tests again.**

Run: `node --test scripts/audiogram-job-logs.test.mjs`

Expected: All tests pass. Lookup returns events for one UUID only.

### Task 7: Reconcile the feature note and run tests

**Files:**
- Change `docs/features/single-run-worker-observability.md`.
- Change the spec only if implementation adds an intentional difference.
- Test the files listed in this task.

**Interfaces:**
- Make the feature note match the implementation, tests, and approved spec.
- Document each intentional difference in the feature note.

- [ ] **Step 1: Update the diagrams and feature note.**

Update the diagrams for per-job files, `partial` status, retry, and local event lookup. Add implementation details and intentional differences. Set `status: COMPLETE`, `design-reviewed: true`, and `implementation-reconciled: true` only after tests pass.

- [ ] **Step 2: Run focused acceptance tests.**

Run: `node --test plugins/audiogram-helper/job-diagnostics.test.mjs plugins/audiogram-helper/server.test.mjs scripts/audiogram-job-logs.test.mjs scripts/single-url-pipeline.test.mjs scripts/youtube-inbox-pipeline-core.test.mjs scripts/clip-processing-core.test.mjs scripts/pipeline-logger.test.mjs`

Expected: All tests pass. They check isolation, migration, stream capture, stage results, retries, and local lookup.

- [ ] **Step 3: Run repository checks.**

Run: `npm run verify:feature-docs`

Expected: The feature-doc check passes. Then run `npm run test:audiogram-plugin` and `npm run test:youtube`.

- [ ] **Step 4: Review the final diff.**

Run `git diff --check`. Review changes to the plugin, scripts, `package.json`, feature note, and spec.

Expected: No whitespace errors. No unrelated drafts change. No secret, transcript, raw log output, upload, or publishing behavior enters the diff.
