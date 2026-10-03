# Pipeline logging system

## Current implementation: live pipeline logs (2026-10-02)

This section supersedes the historical snapshot below. See `docs/features/live-pipeline-logs.md` for the reconciled feature flow and `docs/research/openshorts-system-logs-architecture.md` for the comparison reference.

- **Producer:** `youtube-pipeline.mjs` assigns one run ID and wraps the overall pipeline and broad analysis/render stages. `youtube-inbox-pipeline-core.mjs` reports heatmap/transcript retrieval, validated moment selection, optional Jev ranking and per-video outcomes. `clip-processing-core.mjs` reports asset acquisition, rendering and local queue insertion.
- **Lifecycle:** started → completed/failed; an overall run with returned item failures is partial. Durations accompany terminal stage events. Generic errors become `operation_failed`; safe diagnostic errors retain their code. No free-form errors, transcripts or model responses are persisted.
- **Schema:** timestamp; runId, stage, status, videoId, packageVersion, treatmentId, itemId, clipPackageId, errorCode; nonnegative durationMs and count. Identifiers have restricted characters and a 128-character limit. Fields are optional except stage/status. Raw message and errorMessage fields are excluded on both write and read.
- **Storage:** same configurable local JSONL file and creation permissions. Writes and event callbacks are best effort. Each append starts and ends with a newline to isolate interrupted records. No rotation, retention policy or database migration.
- **Reader/API:** `pipeline-logger.mjs` reads a bounded suffix (at most 8 MiB), skips malformed records, normalizes fields and returns newest-first results capped at 1,000. Missing file returns an empty list; other I/O failures reach the HTTP error response. `/api/logs` is uncached. A bounded tail can contain fewer records than requested.
- **UI:** `public/publishing/activity.mjs` renders the latest 500-event window with run selection, local timestamps, friendly messages, duration/context, error styling, expandable fields, terminal collapse and follow-scroll. Completion-based two-second polling prevents overlapping requests; requests abort after ten seconds. Background tabs pause polling. Errors preserve the last snapshot. Ten-minute silence without a run terminal is unknown, not proof of a dead process.
- **Tests:** dedicated logger and activity tests, pipeline-core event assertions and HTTP logs-endpoint tests. Tests use temporary fixtures and never approve/publish real media.
- **Limits:** no raw subprocess output or percentage progress; no full historical run index, search, artifact linking or liveness heartbeat. Existing sparse logs remain sparse. Restart the publishing server to load backend changes; only new pipeline runs emit richer records.

Logging remains observational: it cannot approve, schedule, retry or publish clips. The existing queue's human approval boundary is unchanged.

## Historical snapshot (before live pipeline logs)

This document describes the local implementation on `main` at `dbfbb90` (2026-10-01). It is a descriptive snapshot for comparison with another logging system, not a proposed design. Follow-up robustness changes in a separate worktree are not included in this snapshot unless they are merged into `main`.

The logging system provides local observability for the YouTube-to-audiogram pipeline. It records stage events to an append-only JSON Lines file, serves recent events through the local publishing server, and shows a short activity summary in the publishing UI. It does not control approval, scheduling, or external publishing.

## Component flow

```text
scripts/youtube-pipeline.mjs
  └─ createPipelineLogger(...).event(event)
       └─ append one normalized JSON object + newline
            to ~/Library/Application Support/Audiogram Inbox/pipeline.jsonl
              └─ GET /api/logs?limit=50
                   └─ public/publishing/app.mjs
                        └─ Pipeline activity list
```

## Event producer and lifecycle

`scripts/youtube-pipeline.mjs` creates one random 24-character hexadecimal `runId` per process invocation. It emits two events per stage:

1. `transcript-sync`: `started`, then `completed` after playlist synchronization and transcript analysis return.
2. `render-and-queue`: `started`, then `completed` after clip packages are processed and completed artifacts are enqueued in the local publishing ledger.

The `completed` event includes elapsed `durationMs`. Events also include the run ID and package version; `videoId` is present when the run is filtered to a requested video. A pipeline run that returns per-video, package, or treatment failures still emits the stage-level `completed` event before the script sets a nonzero exit code. A thrown error can leave the last logged stage at `started`.

## Event record format

`scripts/pipeline-logger.mjs` adds an ISO-8601 UTC `timestamp`, then copies only fields from this allowlist:

| Field | Meaning | Emitted by the current pipeline |
| --- | --- | --- |
| `timestamp` | Time the logger normalized the event | Yes, generated by the logger |
| `runId` | Correlates stage events from one process invocation | Yes |
| `stage` | Pipeline stage name | Yes: `transcript-sync`, `render-and-queue` |
| `status` | Stage transition | Yes: `started`, `completed` |
| `videoId` | Requested video filter, when supplied | Optional |
| `packageVersion` | Selection/package recipe version | Yes |
| `treatmentId` | Treatment identifier | Allowed, not emitted by current stage calls |
| `itemId` | Related item identifier | Allowed, not emitted by current stage calls |
| `durationMs` | Stage elapsed time | On `completed` events |
| `errorCode` | Sanitized error category | Allowed, not emitted by current pipeline calls |
| `errorMessage` | Sanitized error summary | Allowed, not emitted by current pipeline calls |

Example shape:

```json
{"timestamp":"2026-09-30T06:34:24.872Z","runId":"0123456789abcdef01234567","stage":"render-and-queue","status":"completed","packageVersion":"v1","durationMs":20117}
```

Each line is an independent JSON object. There is no separate severity level, free-form message, span context, nested attributes object, or per-clip event in the current producer. The list above distinguishes the logger's accepted fields from fields that production code actually emits.

## Storage and privacy

- Default file: `~/Library/Application Support/Audiogram Inbox/pipeline.jsonl`.
- Override: `AUDIOGRAM_PIPELINE_LOG_PATH`.
- Writes create the parent directory with requested mode `0700` and append newline-delimited JSON with requested file mode `0600` when the file is created.
- The log is local and append-only. The current implementation does not rotate or truncate it.
- The event allowlist excludes transcript text, captions, API keys, and OAuth tokens.
- `runId` is generated in memory for correlation and is not persisted in the database.

## Read API

`scripts/publishing-server.mjs` serves `GET /api/logs`. The `limit` query parameter defaults to 100 at the server; integer values are clamped to 1–1,000, and invalid numeric values fall back to 100. The browser asks for 50 events by default. The response shape is:

```json
{"events":[{"timestamp":"…","runId":"…","stage":"…","status":"…"}]}
```

`readPipelineEvents` returns newest records first. A missing log file produces an empty array. In the current implementation it reads the entire file, parses every nonempty line, then applies the limit. A malformed line causes the read to fail, including an incomplete trailing line.

## Publishing UI

`public/publishing/app.mjs` loads `/api/logs?limit=50` when the page initializes and when the user presses “Refresh activity.” It currently renders only `timestamp`, `stage`, and `status` from each event. The other structured fields remain in the API response but are not displayed in the activity list. The page is an observability view; it does not trigger or alter pipeline execution.

## Failure and side-effect behavior

- Logger writes are awaited by the pipeline. A directory creation or append error can therefore interrupt the pipeline.
- Stage events are emitted as `completed` after operations return, before the script checks returned failure counters. Thrown errors do not currently produce a stage-level `failed` event.
- API reads are not bounded by the requested record count before file loading and parsing.
- Invalid or partial JSONL records currently make the API read fail rather than returning other valid records.
- Logging does not approve queue items, schedule posts, or publish to Instagram. Queue approval remains an explicit human action.

## Source map

- Event normalization and file I/O: `scripts/pipeline-logger.mjs`
- Event creation and pipeline stage boundaries: `scripts/youtube-pipeline.mjs`
- Log path configuration: `scripts/publishing-config.mjs`
- HTTP read endpoint and limit handling: `scripts/publishing-server.mjs`
- Browser fetch and activity rendering: `public/publishing/app.mjs`
- Feature-flow note: `docs/features/structured-pipeline-logs.md`

## Test coverage

`public/publishing/app.test.mjs` covers the browser client's `/api/logs?limit=50` request and payload handling. The current `main` snapshot has no dedicated `scripts/pipeline-logger.test.mjs`; the publishing-server tests also do not exercise the logs endpoint. The event writer, tail parsing, malformed-record behavior, and server/UI field presentation therefore have limited direct regression coverage in this snapshot.

## Comparison dimensions

When comparing this implementation with another logging system, compare event granularity, correlation IDs, field schema, timestamp semantics, failure representation, storage and retention, read/query cost, malformed-record recovery, privacy filtering, UI exposure, and whether logging failures can affect the work being observed.
