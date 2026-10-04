# Single-run worker observability design

## Status

Draft for user review. This document specifies local per-job diagnostics for
the single-URL Audiogram worker. It does not authorize implementation yet.

## Problem

The ChatGPT MCP flow persists a job UUID and terminal state, but currently loses
the useful failure context between the detached worker, command contract, and
MCP response. `job-worker.mjs` discards child stdout/stderr on failure, the
single-URL pipeline collapses several failure classes into a generic message,
and its calls into the shared pipeline core do not provide the core's stage
event callback. Consequently, a support ID can identify a job without
explaining whether transcript, selection, Jev, asset generation, rendering, or
artifact verification failed.

The user needs a trustworthy, per-attempt record that can be inspected locally
and a useful, privacy-safe failure summary in ChatGPT. Retry must be an
explicit user decision and must create a separately traceable execution.

## Goals

- Preserve stdout and stderr from both the detached worker process and the
  Audiograms CLI child process.
- Persist structured, ordered stage events scoped to one job/run ID, not mixed
  into the general inbox pipeline log.
- Cover transcript, selection, Jev, assets, render, and artifact verification;
  include intake/metadata where they are distinct observable stages.
- Return the job ID and precise safe failure details through MCP status results.
- Make a local operator able to filter/inspect all diagnostics by job ID.
- Offer retry only after the user chooses it; every retry gets a new job ID and
  retains a link to the previous attempt.
- Keep the boundary local-first and suitable for a later authenticated cloud
  support adapter without designing or implementing that adapter now.

## Non-goals

- Automatically retrying failed work.
- Uploading logs, source URLs, transcripts, media, or artifacts to support or
  any telemetry service.
- Exposing raw stdout/stderr, local filesystem paths, secrets, transcript text,
  captions, or provider response bodies in ChatGPT tool results.
- Changing clip selection, rendering, publishing, or OAuth behavior.
- Implementing a cloud database, Cloud Run job, remote log viewer, or customer
  support portal.

## Proposed behavior and interfaces

### Job identity and persistence

Each execution attempt has one UUID `jobId`; it is also the structured event
`runId`. All records and process output for that attempt live under a dedicated
directory such as `.local/audiogram-helper/runs/<jobId>/`. Proposed contents:

- `pipeline.jsonl`: allowlisted structured lifecycle and stage events.
- `worker.stdout.log` / `worker.stderr.log`: outer detached worker streams.
- `pipeline.stdout.log` / `pipeline.stderr.log`: the CLI child streams.
- Existing job-store row: current state, safe summary, failed stage/code, and
  retry relationship metadata.

The exact file layout is an implementation detail, but the per-job isolation
and query-by-job-ID contract are requirements. Files remain under the local
Audiograms data boundary. Create directories with owner-only permissions
(0700) and log files with owner-only permissions (0600), subject to platform
support. Store process output in separate bounded files; use configurable
per-file size caps and a documented retention window so disk use is bounded.
Select concrete defaults during implementation based on existing local-data
conventions and make them configurable without requiring cloud services.

### Structured event contract

Each JSONL record includes an ISO timestamp, `jobId`, `runId`, `stage`, and
`status` (`started`, `completed`, or `failed`). Include only safe bounded
metadata such as `videoId`, `errorCode`, duration, and item/count identifiers
when useful. Do not store transcript/caption text, credentials, full provider
payloads, or arbitrary exception messages in structured fields. A sanitized
`errorMessage` may be included only if it passes an explicit redaction and
length boundary; otherwise store a stable code and keep detailed diagnostics
in protected local raw logs.

Required stage coverage, in actual execution order:

1. `intake` / `metadata` (where applicable)
2. `transcript`
3. `selection`
4. `jev` (always a distinct stage and always represented in the trace; record
   its actual outcome, and never invent a failed/skipped event when it did not
   run)
5. `assets`
6. `render`
7. `artifact_verification`

Events are append-only and emitted at stage start and terminal outcome. Events
for one job are ordered within that job's file. Logging is best-effort with
respect to pipeline execution: logger I/O failure must not mask the real stage
outcome, although the job result should note that diagnostics may be incomplete.

### Failure result shown in ChatGPT

The status/result contract should preserve `jobId` on every terminal result
and provide a machine-readable failure object for a failed job, approximately:

```json
{
  "jobId": "<uuid>",
  "status": "failed",
  "failure": {
    "stage": "render",
    "code": "RENDER_FAILED",
    "message": "Rendering failed. You can inspect this run with its job ID.",
    "retryable": true
  }
}
```

Use a `failures[]` list to preserve each failed stage/package with its stable
stage and error code; do not collapse independent failures into one vague
attribution. Use job status `partial` only when at least one verified artifact
exists and one or more stages/packages failed. If no verified artifact exists,
the terminal status is `failed`. Never replace a precise known stage failure
with “one or more analysis, asset, or render steps failed.” Local raw
diagnostics remain available by `jobId` and are not returned wholesale to
ChatGPT.

### Local diagnostics lookup

Provide an operator-facing way to request a run by UUID (a CLI command or
documented existing diagnostic interface). It returns safe structured events
only and must validate UUID input and never search or return another run's
records. It may report the local paths of protected stdout/stderr files to the
operator, but it does not print raw output or tails. The existing general
`/api/logs` feed must not be used as the storage location for these job events
because runs must stay isolated.

### Explicit retry

Retry is a new execution, never a mutation/reopening of the failed attempt.
Expose a dedicated MCP surface `retry_audiogram({jobId})`: it accepts only a
known terminal failed or partial job, copies its canonical source URL into a
new job, and stores `retryOfJobId` on the new job. ChatGPT instructions/tool
description must ask the user before invoking it; the request itself is not
inferred from a failure. No automatic retry or retry loop is allowed. The new
job has its own isolated logs and UUID. A retry must not be offered as safe
when the failure is non-retryable or when the previous job's source cannot be
validated.

## System boundaries

- `local-runner.mjs` owns job dispatch and query coordination; it associates
  each worker launch with one persisted job UUID and per-job diagnostic path.
- `job-worker.mjs` owns child process lifecycle, stdout/stderr capture, and
  CLI-contract validation; it reports an exact failure classification to the
  job store without flattening useful output.
- `scripts/audiogram-url.mjs` remains the stable command boundary and relays
  the pipeline result contract.
- `scripts/single-url-pipeline.mjs` orchestrates the single-source stages and
  emits stage-level events, including stages beyond the existing core hooks.
- `scripts/youtube-inbox-pipeline-core.mjs` and
  `scripts/pipeline-logger.mjs` may be reused through injected logger/event
  interfaces, but per-job logs must not append to the shared inbox log.
- `server.mjs` exposes safe job status/failure summaries and any approved
  retry tool. It does not expose raw local files through MCP.
- The job store persists the support ID, safe terminal summary, and retry
  relationship. Raw logs and event files remain local files scoped to the ID.

## Security and privacy

- No credentials or raw model/provider responses in logs or MCP output.
- Raw process logs may contain upstream diagnostics; keep them local and
  owner-readable only. Redaction should cover known token/key patterns before
  structured error text is surfaced.
- Do not put source URL query secrets or arbitrary user text into event fields.
- Bound event and raw log sizes; behavior on truncation must be explicit and
  the status must indicate incomplete diagnostics.
- No remote log transfer in the Secure MCP Tunnel phase. The tunnel is only a
  transport to the local MCP server, not authorization to expose log files.
- Future cloud support access requires separate authentication, retention,
  redaction, and authorization design.

## Acceptance criteria

1. A successful or failed job has a unique job ID and isolated event file.
2. A failing stage creates a failed event with exact stage and stable code;
   later stages do not appear completed.
3. Transcript, selection, Jev, assets, render, and artifact verification are
   independently observable in their actual execution order.
4. Worker and CLI stdout/stderr are retained separately, including on child
   failure, without allowing output-buffer limits to erase the failure record.
5. `get_audiogram_status` returns the same job ID and a precise, sanitized
   failure stage/code; no generic multi-stage failure replaces known detail.
6. A local operator can retrieve only the chosen job's events and locate its
   raw stream files using that ID.
7. Retry occurs only after an explicit user choice, creates a new job ID, and
   records the prior ID; no retry occurs automatically.
8. Logger failure cannot hide or replace the actual processing result.
9. Tests prove log isolation under concurrent jobs and safe serialization of
   failure results; secrets and transcript/caption text are absent from MCP
   output and structured events.
10. No external upload, publishing action, or cloud dependency is introduced.

## Decisions confirmed for this design

1. Retry is a dedicated `retry_audiogram` MCP tool.
2. Worker and pipeline stdout/stderr are retained in separate bounded files.
3. Local lookup returns safe structured events only; it does not return raw
   output or log tails.
4. Preserve each failed stage/package in a `failures[]` list. Use `partial`
   only if at least one verified artifact exists; otherwise use `failed`.
5. Jev is a distinct stage. Record its actual outcome, and never synthesize a
   skipped event as a failure.

## Existing behavior and intended change

Existing: UUID job store, MCP create/status tools, detached worker, single-URL
pipeline, generic terminal failure summary, and shared structured logger hooks
in the broader inbox pipeline.

Intended: per-job stage events plus retained process streams, safe stage-aware
ChatGPT diagnostics, a local support lookup by UUID, and explicit linked retry.

Unchanged: transcript-LLM selector default, provider configuration, clip/render
business logic, local artifacts, no-publish behavior, and local Secure MCP
Tunnel boundary.
