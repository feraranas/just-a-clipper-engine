# OpenShorts publishing versus Audiograms

Verified 2026-10-02 against local working trees: Audiograms HEAD
`dbfbb9067cf81ba8a4338690c4553818da554f13`, OpenShorts HEAD
`faff66de0b91277510587a1c778be433ff3d26a4`. Both have local changes;
this is a working-tree observation, not a claim about upstream latest.

## Decision and scope

Implement native Instagram publishing in Audiograms, not OpenShorts. Do not
register for or depend on Upload-Post. Target handle: `theballooninquiries`;
its numeric account ID, token, and actual account eligibility remain unverified.
Keep explicit human approval per clip. This note records source analysis only;
no publishing code, credentials, account settings, or queue records were changed.

## Short answer

OpenShorts has a publishing adapter and cloud orchestration, but the inspected
Instagram paths hand off the actual publishing/scheduling to Upload-Post.
Audiograms has a durable local approval ledger and worker-claim primitive,
but no production Instagram worker or Meta transport in this checkout.
Do not confuse the designed lifecycle with a functioning publisher.

## Flows

OpenShorts manual:
`clip -> post/schedule dialog -> POST /api/social/post -> Upload-Post multipart upload -> vendor response`

OpenShorts cloud Autopilot:
`completed generation -> opt-in autopublish setting -> rank/select clips -> compute daily slots -> background task -> Upload-Post`

Audiograms implemented:
`rendered MP4 -> local SQLite queued item -> preview/caption -> human approve + scheduled time -> approved`

Audiograms missing execution:
`claim due approved item -> Meta upload/container -> processing poll -> publish -> persist confirmed outcome`

## What OpenShorts actually does

- `app.py:5271`, `post_to_socials`: checks job/result/file availability and job ownership,
  resolves provider key/profile, picks the clip and caption, constructs multipart data.
- `app.py:5308`: POST to `https://api.upload-post.com/api/upload` with
  `Authorization: Apikey ...`, video bytes, profile, platform list and `async_upload=true`.
  Instagram adds `media_type=REELS` and `instagram_title`; scheduling adds date/timezone.
- `app.py:5348`: moves blocking upload into a thread; accepts HTTP 200/201/202 and
  returns provider JSON. This route does not create a local per-clip approval record,
  claim a durable publishing job, poll Meta, or reconcile ambiguous publish outcomes.
- `dashboard/src/components/ResultCard.jsx:665`: user explicitly submits the dialog.
  On a successful HTTP response the UI says posted/scheduled successfully. Because
  the vendor request is asynchronous, this is not proof Instagram finished publishing.
- `app.py:5592`: pending schedules are fetched from Upload-Post and filtered by profile;
  cancellation verifies that profile owns the vendor job before forwarding DELETE.
- `app.py:5478`: analytics endpoints proxy provider data; this is not native Meta analytics.
- `app.py:6426`: AI Shorts uses the same vendor adapter pattern. Thumbnail publishing
  (`app.py:6089`) has an in-memory background-job status map, not a durable approval ledger.
- `cloud/autopilot.py:586`: guarded database update settles generation once; enabled
  autopublish selects ranked clips and launches a background task, without per-clip human approval.
- `cloud/autopilot.py:646`: calculates daily slots and uploads each clip; stores accepted
  upload count or `publish_partial`. `_upload_clip` at line 302 treats 200/201/202 as
  success. That count is provider acceptance, not confirmed published Instagram media.

Upload-Post's internal queue, token storage, retries, Meta upload/polling and recovery
cannot be established from these call sites. They are outside the inspected repository.
Do not describe that unseen backend as audited or assume a particular reliability model.

## Audiograms implementation and gaps

- `scripts/publishing-completion.mjs:26`: hashes a validated in-repository MP4;
  `enqueueCompletedArtifact` at line 43 enqueues completed artifacts.
- `scripts/publishing-ledger.mjs`: SQLite state machine includes queued, approved,
  rejected, uploading, container_created, processing, published, failed and unknown.
- `approveItem` at line 351 persists scheduled time, approval timestamp and approved
  artifact hash. Captions remain editable in queued/approved states; approval is not
  currently an immutable snapshot of every publication field.
- `claimDueApprovedItem` at line 394 transactionally selects a due approved item and
  changes it to uploading. This is a worker building block, not a running worker.
- `recordUnknownOutcome` at line 414 records ambiguous external outcomes. Unknown has
  no ordinary outgoing transition; do not blindly retry an uncertain publication.
- `scripts/publishing-server.mjs:80`: local approve/schedule/reject/caption/retry routes.
  Retry only reapproves failed records; it does not itself implement backoff or publishing.
- `docs/features/local-approval-queue-ui.md` explicitly describes the worker as future work.
- A source search in `scripts` and `src` found no production caller of
  `claimDueApprovedItem`, native Meta transport, or `media_publish` implementation.
  Worker claim is exercised by ledger tests. This finding is limited to this checkout.

## What is worth reusing

Useful concepts: caption/platform payload separation, timezone-aware schedules,
nonblocking uploads, account ownership checks, separating generation completion from
publication, and schedule listing/cancellation UX. These are reference ideas, not a
reason to copy their vendor dependency or replace our ledger.

Keep Audiograms' durable queue, approval boundary, artifact identity and unknown-outcome
model. The missing bounded subsystem is a native Meta adapter plus worker and credential
setup, with durable container/media IDs, safe retries, recovery and verified outcomes.
This is future scope, not an approved implementation plan in this analysis.

## Reuse this analysis

Read this note before repeating a full comparison. Recheck relevant functions when
either checkout changes; line numbers are navigation hints, function names are the
stable anchors. For implementation, reconcile the older publishing design and follow
the repository DESIGN/RECONCILE workflow. Do not reuse the OpenShorts-specific native
Instagram design as if it were the Audiograms implementation.
