# Job debug console

A read-only page at `http://127.0.0.1:8787/debug/jobs` (same server and `PORT` as the [approval UI](./approval-ui.md)) to inspect any recent Audiogram job: summary, stage events and callback deliveries. It replaced the approval page's "System logs" panel (that page now only has a `Debug jobs ↗` link). It never starts, retries, cancels, approves or publishes anything.

## Sub-features

- `debug-list` `GET /api/debug/jobs` → `{"source":"<label>","jobs":[...],"nextCursor":null}` (50 per page, newest first, `status` / `title` / `failures` / `artifactCount` / `capture`).
- `debug-job` `GET /api/debug/jobs/<jobId>` → `{"source","job","notification":{"delivery":"not_subscribed",...}}`. A non-UUID id → `400`.
- `debug-events` `GET /api/debug/jobs/<jobId>/events` → `{"events":[...]}` from the job's `pipeline.jsonl`.
- `debug-deliveries` `GET /api/debug/jobs/<jobId>/deliveries` → `{"available":true,"deliveries":[],"nextCursor":null,"attemptHistoryAvailable":false}` (no callbacks without a ChatGPT subscription).
- `debug-guard` routes are GET-only (`POST` → `405`) and loopback-only (a foreign `Host` header → `403`). A missing jobs database → `503 {"error":"Job database unavailable"}`; the file is not created.
- `debug-page` `/debug/jobs?job=<jobId>` renders the job: source label, job list, summary (processing, verified artifacts, event capture, callback delivery as separate facts), an event table with stage/clip/status/time/text filters and a `Pause updates` control that refreshes every 2 s. It states that stage activity is recorded history, not a worker heartbeat.

## How to get to it (user POV)

- `npm run debug:serve` (builds the page bundle, then starts the publishing server), open `http://127.0.0.1:8787/debug/jobs`, or follow `Debug jobs ↗` from the queue page.
- Sources: `AUDIOGRAM_DEBUG_JOBS_DB_PATH` (default `AUDIOGRAM_JOB_STORE`, else `.local/audiogram-helper-jobs.sqlite` in the checkout), `AUDIOGRAM_DEBUG_DIAGNOSTICS_ROOT` (default `AUDIOGRAM_DIAGNOSTICS_ROOT`, else `.local/audiogram-helper/runs`), label `AUDIOGRAM_DEBUG_SOURCE_LABEL` (default `Local jobs`).

## Driving it with clipctl

Preconditions:

- Node >= 22.13. A job record: create one through the [MCP helper](./mcp-helper.md) (`create_audiogram`, heatmap selector, with `AUDIOGRAM_DIAGNOSTICS_ROOT=$STATE/diag`). A job that fails (for example the YouTube 429 described in [audiogram-url](./audiogram-url.md)) is a valid subject: the console should show `Failed`, the `ASSET_FAILED` failure and the failed `assets` event. Do not create a job just to test the console if the pipeline cannot reach YouTube; use the fixture check below.

- **Build.** `npm run debug:build` → `Built local job console.` (outputs are gitignored).
- **Start.** `mkdir -p $STATE/data; AUDIOGRAM_DATA_ROOT=$STATE/data PORT=18787 AUDIOGRAM_DEBUG_JOBS_DB_PATH=$PWD/.local/audiogram-helper-jobs.sqlite AUDIOGRAM_DEBUG_DIAGNOSTICS_ROOT=$STATE/diag AUDIOGRAM_DEBUG_SOURCE_LABEL=verify-run node scripts/publishing-server.mjs`; wait for `Publishing server listening`.
- **API.** `curl` the four routes above with the job id; check `400`/`403`/`405`.
- **Look.** `skills/verify-just-a-clipper-engine/scripts/ui-shot.mjs "http://127.0.0.1:18787/debug/jobs?job=$JOB" $EVIDENCE/debug-jobs.png 4000`. Expect `Source: verify-run`, the title and job id, `Processing Failed` (or `Complete`), `Stage events N`, one row per event, and `Stage activity is recorded history, not a worker heartbeat.`
- **Missing source.** Start with `AUDIOGRAM_DEBUG_JOBS_DB_PATH=$STATE/nope.sqlite` (existing data root): `/api/debug/jobs` → `503`, `nope.sqlite` is not created, `/api/items` still `200`.
- **Fixture browser check.** `CHROME_PATH=... node scripts/job-debug-browser-check.mjs` builds temporary databases/logs and a private Chrome profile, then prints `PASS browser: recent jobs, filters, expansion, live append, deliveries, job isolation, stale read, mobile layout, publishing navigation.` This covers populated, delivery and live-refresh states a real failed job cannot.

## Gotchas

- Pointing the console at the real jobs database (`.local/` in a checkout used by the live MCP server) is read-only but exposes real job titles; use a scratch source for evidence.
- Callback delivery rows need a real ChatGPT subscription; only the empty `not_subscribed` state is driven live. The stopped-callback wording fix (`0736fb6`) is covered by `scripts/job-debug-store.test.mjs`, not by a live drive.
