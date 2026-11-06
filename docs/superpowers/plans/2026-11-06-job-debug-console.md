# Job Debug Console Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan inline, task by task.

**Goal:** Choose a recent job and inspect its stage and callback records in a separate local console.

**Architecture:** Add a read-only diagnostic adapter and guarded GET routes to the existing publishing server. Build a React/TanStack Table page with esbuild. Remove the publishing page's activity panel after replacement verification.

**Tech Stack:** Node SQLite, JSONL, React 19, TanStack Table 9.3.1, esbuild.

**Spec:** `docs/features/job-debug-console.md` (approved 2026-11-06).

## Global constraints

- Read-only diagnostic access; no migrations, processing, publishing, or real-ledger writes.
- Local same-origin GET routes; bounded rows and bytes; safe response fields only.
- Recent jobs: 50 per page. Auto-refresh: two seconds, non-overlapping, paused when hidden.
- Preserve stable selection, filters, expanded rows, and scroll; explicit Follow control.
- Historical delivery errors that were erased remain unavailable.
- No persistent server or tunnel changes; validation uses disposable fixture servers.

## Review focus

- Concurrent inserts during pagination: stable keyset job cursors (Task 1).
- Damaged, truncated, or substituted log files: bounded safe reads and visible errors (Task 1).
- Other website requesting diagnostics: Host/Origin and fetch-site guards (Task 2).
- Slow response after job switch: abort and generation checks (Task 3).
- Terminal processing with pending callbacks: polling continues (Task 3).

## Task 1: Read-only diagnostic adapter

Files: `scripts/job-debug-store.mjs`, `scripts/job-debug-store.test.mjs`.
Interface: `createJobDebugReader({jobsDbPath,diagnosticsRoot,sourceLabel})` returns
`listJobs({cursor,limit})`, `getJob(jobId)`, `events(jobId,{cursor,limit})`, and
`deliveries(jobId,{cursor,limit})`. Open and close a read-only SQLite connection
per operation. Safe JSONL rows use `normalizePipelineEvent`.

- [x] Write tests with temporary jobs DB and per-job JSONL: recent ordering and paging,
  exact job isolation, late appends, malformed/incomplete lines, missing sources,
  invalid cursor/ID, secret exclusion, read-only schema, and symlink escapes.
- [x] Run tests and confirm missing functionality fails.
- [x] Implement bounded reader, safe summary mapping and delivery projection.
- [x] Run tests and inspect all results.

## Task 2: Local routes and build

Files: `scripts/job-debug-http.mjs`, `scripts/job-debug-http.test.mjs`,
`scripts/publishing-server.mjs`, `scripts/build-job-debug.mjs`, `package.json`.
Interface: `handleJobDebug(request,response,{reader,publicRoot})` returns whether
it handled the request. `/debug/jobs` serves the page; `/api/debug/jobs` and
job detail/events/deliveries routes are GET only. No-store and safe error codes.

- [x] Test real HTTP requests with local temporary fixtures, cross-origin and forged
  Host rejection, invalid arguments, unknown routes, and unavailable build files.
- [x] Implement routes and wire them before the existing publishing router.
- [x] Add `debug:build` and `debug:serve`; pin TanStack 9.3.1 and build local assets.
- [x] Run HTTP and existing publishing-server tests.

## Task 3: Console and panel replacement

Files: `src/job-debug/App.tsx`, `src/job-debug/styles.css`,
`src/job-debug/index.tsx`, `public/job-debug/index.html`,
`public/job-debug/controller.mjs`, `public/job-debug/controller.test.mjs`.
Interface: refresh controller owns abort/generation/timer state; React displays
safe results. TanStack provides filtering and sorting. Event and delivery
pagination retain loaded rows; refresh rereads the loaded pages and preserves
row expansion through stable identity.

- [x] Test refresh controller: stale requests, errors, pause/resume, cleanup,
  non-overlapping requests, and continued polling after terminal results.
- [x] Build recent-job selection, summary, event/delivery tabs, time/stage/clip/status
  filters, sorting, expandable detail, pagination, follow, refresh status and errors.
- [x] Remove activity initialization and System logs markup/CSS/view from
  `public/publishing`; retain `/api/logs` compatibility.
- [x] Verify browser behavior with fixture data, desktop/narrow layouts and error
  states; verify publishing navigation and no former activity polling.

## Task 4: Reconcile and deliver

- [x] Run targeted tests, `npm run lint`, `npm run test:ci`, frontend build and
  `npm run verify:feature-docs`; inspect failures, not just exit codes.
- [x] Review diff inline; update design to actual interfaces, limits and deviations.
- [x] Document startup/configuration and verification in `docs/job-debug-console.md`.
- [x] Mark feature COMPLETE only after implementation and reconciliation succeed.

## Execution record

- Worktree isolated at `job-debug-console`; branch `codex/job-debug-console`.
- npm registry confirms `@tanstack/react-table` 9.3.1. No subagents.
- All four tasks implemented. Reader, routes and refresh controller were tested
  for missing functionality before implementation, then rerun successfully.
- Full CI: 81/81 files. Final focused tests: 21 passed. Lint/typecheck and asset
  build passed. Disposable browser acceptance passed desktop and narrow layouts.
- Read-only check of the recent real job returned 30 stage rows and 25 deliveries.
  No real job, publication, persistent server or tunnel was started.
- No commit, push, PR, or deployment is part of this execution record.
- Feature-document gate: 29 notes verified, including the reconciled COMPLETE note.
