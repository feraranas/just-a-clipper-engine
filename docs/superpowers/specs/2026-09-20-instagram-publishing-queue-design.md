# Instagram Publishing Queue Design

## Status

Design approved in conversation; implementation has not started.

## Goal

Place completed Remotion artifacts into a local approval queue and publish explicitly approved Reels to one Instagram Professional account on a routine schedule.

The system must preserve the existing artifact pipeline, require human approval before publication, be safe to inspect and retry, and record enough state to distinguish a failed request from an ambiguous external outcome.

## Scope

### V1 includes

- Rendered MP4 artifacts as Instagram Reels.
- A local web page with video previews.
- Caption editing, approval, rejection, and scheduling.
- One Instagram Business or Creator account.
- A local scheduled publisher.
- Object storage or equivalent temporary public media hosting.
- SQLite-backed publishing state.
- Explicit handling of upload, processing, publish, and unknown states.

### V1 excludes

- Automatic caption generation.
- Instagram Stories, carousels, DMs, comments, or analytics.
- Multi-account support.
- Hosted dashboard or user authentication.
- Automatic retry after an ambiguous publish result.

## Architecture

```text
Remotion render
    |
    v
Publishing record: queued
    |
    v
Local approval page
    |-- approve --> approved --> scheduled publisher
    |-- reject  --> rejected
    |-- edit caption
    v
Temporary public media URL
    |
    v
Instagram media container
    |
    v
Processing status poll
    |
    v
Instagram media_publish
    |
    v
Published record + Instagram media ID
```

The Remotion pipeline remains responsible for producing and validating artifacts. The publishing layer consumes completed artifacts and does not alter rendering behavior.

## Publishing lifecycle

The primary states are:

```text
queued -> approved -> uploading -> container_created -> processing -> published
   |         |             |              |               |
 rejected   failed       failed         failed          failed
```

An ambiguous timeout after the publish request enters `unknown`. It cannot be retried until the operator verifies whether Instagram created the post. Rejection is terminal for that record unless a future explicit “reopen” action is added.

Only `approved` records whose scheduled time has arrived are eligible for publishing. Approval is a hard gate; rendering alone never authorizes publication.

## Local web page

The first page is a small local server backed by the publishing ledger.

### Views

- Queue view grouped by queued, approved, failed, unknown, and published.
- Item view with inline MP4 preview, source metadata, artifact path, caption, and schedule.
- Published view with Instagram media ID and publication timestamp.

### Actions

- `POST /items/:id/approve`
- `POST /items/:id/reject`
- `POST /items/:id/caption`
- `POST /items/:id/schedule`
- `POST /items/:id/retry` only for confirmed-safe failed states
- `POST /items/:id/verify-published` for unknown states

The server must serve only validated repository-relative artifact paths. It must not accept arbitrary filesystem paths from the browser.

## Data model

Each publishable artifact receives a publishing record linked to the existing processing record where available.

Required fields:

- stable record ID
- artifact-relative path
- artifact content hash
- source video, clip, package, and treatment identifiers when available
- title and caption
- target account identifier
- scheduled time
- current publish state
- created, updated, approved, rejected, and published timestamps
- approval decision and optional rejection reason
- media-hosting key or URL
- Instagram container ID
- Instagram media ID
- last error code and message
- retry count and last retry timestamp

The content hash prevents approving one file and later publishing a silently replaced file. A changed artifact must create a new or explicitly revalidated publishing record.

## Publisher behavior

On each scheduled run, the worker:

1. Selects the oldest eligible approved record.
2. Revalidates that the artifact exists, is non-empty, and matches its approved hash.
3. Uploads it to the configured media host.
4. Creates an Instagram media container with the caption and Reel settings.
5. Polls container status until `FINISHED`, an error, or a bounded timeout.
6. Calls `media_publish` with the container ID.
7. Records the Instagram media ID and publication timestamp.
8. Removes temporary media only after the result is safely recorded.

The worker should process one item at a time initially. This keeps rate limits, duplicate prevention, and debugging simple.

## External API boundary

The Instagram adapter must isolate Meta-specific calls from the queue and scheduler. It should expose operations equivalent to:

- create media container
- upload or register media
- read container status
- publish container
- verify a suspected publication

Credentials must come from the local environment or a secure credential store and must never enter SQLite, captions, logs, or repository files.

## Media hosting boundary

Instagram requires media reachable through a public URL or an upload session. The implementation must hide this behind a media-host interface so the initial storage provider can be replaced later.

Temporary objects should have an expiration policy. Cleanup must be conservative: an object is not deleted while the item is in `processing` or `unknown`.

## Failure and recovery rules

- Missing, empty, or hash-mismatched artifact: mark failed; do not call Instagram.
- Media-host upload failure: mark failed; safe to retry.
- Container creation failure: mark failed; safe to retry after inspection.
- Processing error: mark failed; do not blindly retry the same container.
- Publish request returns a clear API error: mark failed; retry only after inspection.
- Publish request times out or connection state is unknown: mark unknown; require verification.
- Ledger write fails after a successful external publication: preserve the external ID if available and surface an operator-recovery path.

Every failure should retain the first error, latest error, relevant external IDs, and timestamps.

## Scheduling

V1 uses a local scheduled worker because the current artifact pipeline and authenticated source workflow are local. The worker must be invokable manually as well as from the scheduler, so each run can be tested without waiting for the scheduled time.

The scheduling mechanism itself remains replaceable. A later always-on runner can consume the same approved queue and publisher interface without changing the local approval model.

## Verification strategy

Before claiming the system works, verify independently:

- A rendered artifact appears in the queue.
- The preview plays from the local page.
- Caption edits persist.
- Rejection prevents publication.
- Approval creates an auditable approval record.
- A changed artifact hash blocks publication.
- A simulated upload failure is recoverable.
- A simulated unknown publish outcome does not automatically duplicate.
- A successful test publication records the Instagram media ID.
- A second scheduler run does not republish a published item.

Tests should cover the queue state machine and publisher orchestration without requiring live Instagram credentials. A separate manual smoke test will validate the live Meta integration.

## Open decisions for implementation

## Approved implementation defaults

- Object storage: Cloudflare R2 using its S3-compatible API.
- Successful uploaded-object retention: 7 days after publication.
- Failed or unknown uploaded-object retention: 30 days.
- Local UI: Node standard library server with vanilla HTML, CSS, and JavaScript.
- Schedule: daily at 18:00 in `America/Mexico_City`; timestamps are stored in UTC.
- Account setup: the user will confirm that the Instagram account is Professional and has the required publishing permissions.
- First smoke test: use the real account with exactly one explicitly approved Reel.

The first smoke test must still verify the resulting Instagram media ID and confirm that a subsequent scheduler run does not duplicate the post.
