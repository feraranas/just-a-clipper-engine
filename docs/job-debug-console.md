# Local job console

Use the console to inspect a Job ID returned by ChatGPT. It reads the jobs
database and each job's structured `pipeline.jsonl`. It does not start or retry
jobs. The publishing queue now links to this page instead of showing System logs
at the top.

## Start in your terminal

From the checkout that contains this feature:

```sh
npm ci
npm run debug:serve
```

Open <http://127.0.0.1:8787/debug/jobs>. Keep this terminal visible. Use Ctrl+C
to stop the server. If port 8787 is busy, use `PORT=8788 npm run debug:serve` and
open <http://127.0.0.1:8788/debug/jobs>.

`debug:serve` builds local assets and starts the existing publishing HTTP server.
It loads `.env` when present and uses the publishing service's usual ledger
configuration. The debug routes only read the job data. They do not initialize
or migrate the jobs database. No MCP server or tunnel restart is required.

## Choose the data source

Defaults are `.local/audiogram-helper-jobs.sqlite` and
`.local/audiogram-helper/runs` under the checkout. A new worktree may have no job
data. Point it to the database and logs used by the MCP worker; do not copy a
running database or move the worker.

| Variable | Purpose / fallback |
| --- | --- |
| `AUDIOGRAM_DEBUG_JOBS_DB_PATH` | Existing jobs SQLite file; falls back to `AUDIOGRAM_JOB_STORE`, then the local default. |
| `AUDIOGRAM_DEBUG_DIAGNOSTICS_ROOT` | Directory containing Job ID folders; falls back to `AUDIOGRAM_DIAGNOSTICS_ROOT`, then the local default. |
| `AUDIOGRAM_DEBUG_SOURCE_LABEL` | Visible source label; defaults to `Local jobs`. |
| `PORT` | Local HTTP port; defaults to 8787. |

For the MCP test data inspected on 2026-11-06:

```sh
AUDIOGRAM_DEBUG_JOBS_DB_PATH=/Users/kiwi/.codex/worktrees/mcp-event-delivery/Audiograms/.local/audiogram-helper-jobs.sqlite \
AUDIOGRAM_DEBUG_DIAGNOSTICS_ROOT=/Users/kiwi/.codex/worktrees/mcp-event-delivery/Audiograms/.local/audiogram-helper/runs \
AUDIOGRAM_DEBUG_SOURCE_LABEL="MCP test jobs" \
PORT=8788 npm run debug:serve
```

That source contains job `92fd058e-e006-4f69-bce7-c267983fdec8`: partial success,
two verified artifacts, and a render failure for clip 36. This is a historical
example; current data can change. Use absolute paths for another source.

## Inspect a run

1. Choose a recent job or paste its exact Job ID. The URL retains the selection.
2. Read processing, artifact count, capture health, and callback health separately.
3. Filter stage rows by stage, clip, status, time, or text. Click a column to sort.
4. Expand a row to see its safe structured fields.
5. Open Callback deliveries to see sequence, attempts, status, and acknowledgement.

Recent jobs load 50 at a time. Event and delivery records load 100 at a time;
use the load button for older/later pages. Filters apply to **loaded rows**.
Each refresh rereads the loaded pages, including after processing finishes.
This is two-second auto-refresh, not a streaming connection. Pause updates to
inspect a fixed view. Hidden tabs pause reads and refresh when visible again.
Follow new rows is optional; filters and expanded rows persist across refreshes.

The page retains the last successful view after a read error and labels it stale.
Missing logs, malformed records, incomplete final lines, and worker-reported
incomplete diagnostics have visible notices. Replacing a log during pagination
causes a new read rather than mixing file generations.

## What this console can prove

- It shows recorded stage activity. A quiet log is not proof that a worker stalled.
- A callback acknowledgement confirms receipt, not that ChatGPT displayed a message.
- Delivery rows retain attempt counts and current results. Earlier errors cleared
  by acknowledgement cannot be reconstructed here.
- Raw stdout/stderr, callback URLs, credentials, and arbitrary ledger error text
  are excluded. A generic `RENDER_FAILED` remains generic if that is all the
  structured record contains. Renderer error retention is separate work.

Debug routes accept local same-origin GET requests only, use no-store responses,
and serve local assets. Do not expose this service through the MCP tunnel.
The existing publishing routes and their approval controls remain in this service.

## Verify changes

```sh
node --test scripts/job-debug-store.test.mjs scripts/job-debug-http.test.mjs public/job-debug/controller.test.mjs
npm run lint
npm run debug:build
node scripts/job-debug-browser-check.mjs
npm run test:ci
npm run verify:feature-docs
```

The optional browser check uses a temporary fixture database, a loopback server,
and a private headless Chrome profile. It closes them on exit. On macOS it uses
the standard Google Chrome path; set `CHROME_PATH` for another installation.
It never creates a real video job or publishes a clip.
