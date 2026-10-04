# Native Instagram publishing: one-shot operator runbook

This command uses Meta directly, not Upload-Post. Target username is fixed to
`theballooninquiries`. No service or schedule runner is installed. The approval
dashboard stays a separate process.

## Explicit configuration

Use Node 22 with `node:sqlite`. Put the Page access token, linked Page ID and
Instagram account ID in an ignored env file with mode `600`. Use the placeholders
in `.env.example`; never paste tokens in CLI arguments or commit them. The worker
does not find or copy credentials from another checkout. Use Facebook Login
permissions `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`
and `pages_show_list` for account discovery. App roles/access and Page linkage must
also permit the operation. Standard access is for your app's authorized accounts,
not arbitrary customers.

Tokens expire or can be revoked early. `--check-account` verifies current usability
and linkage, **not expiry**. Check expiry/data-access expiry in Meta's token debugger;
do not infer a permanent token from successful reads. No automatic token refresh is
implemented. The integration uses Graph `v26.0`, configurable explicitly.

From the isolated feature checkout, using an explicitly selected credential file:

```sh
node --env-file=/absolute/path/to/ignored.env scripts/publishing-run.mjs --check-account
```

This performs only two identity reads; it never opens or migrates a database.

## Approve and execute one item

Prefer an isolated ledger and artifact root for development. Using an existing
queue requires explicit permission: first open adds schema fields and invalidates
older approvals without caption snapshots. Live validation used the existing queue
at the user's explicit request. Preview the actual MP4 and caption in the
approval dashboard; enqueueing/rendering does not approve anything. Set the real
account ID on enqueue, then explicitly approve and schedule. Local-placeholder
accounts are not remapped. Caption edits invalidate approval. Legacy approvals
without a caption snapshot migrate back to queued for fresh review.

```sh
PORT=8788 PUBLISHING_DB=/absolute/path/to/isolated.sqlite node scripts/publishing-server.mjs

node --env-file=/absolute/path/to/ignored.env scripts/publishing-run.mjs \
  --db /absolute/path/to/isolated.sqlite \
  --project-root /absolute/path/to/isolated-artifact-root \
  --item APPROVED_ITEM_ID --live
```

The dashboard serves artifacts relative to its working directory. Launch it from
the selected checkout with the same artifact root as the worker. The worker refuses
missing DBs, relative root/DB paths and missing `--live`. That flag is **not** a
substitute for per-item approval. Only due, approved items for the verified account
are eligible. It rejects symlinks, hashes the open descriptor, streams bounded
chunks, then rechecks integrity before publishing. Verify MP4 format/dimensions/
codec/duration with `ffprobe` and the current Meta media specification first.

## Outcomes and recovery

- Exit 0 / `published`: Meta media ID persisted, or previously published no-op.
- Exit 2 / `pending`: upload/status work needs later inspection. A later one-shot
  invocation reads the same container; it does not blindly resend bytes.
- Exit 1: stopped, ineligible, failed, or unknown. Inspect sanitized outcome and DB.
- `unknown`: never automatically retry. Publication may have succeeded. Container
  status alone cannot recover the media ID. Inspect Meta/account media and reconcile
  manually; the generic retry route refuses this state.
- `failed`: only positively classified safe failures can use the retry route; retry
  returns to queued for new human approval, retaining historical attempts.
- If an output contains `confirmedMediaId`, Meta returned that ID but a local commit
  failed. Preserve it for operator reconciliation. Never replay `media_publish`.

GET requests retry at most three times. POSTs are not retried. Polling performs at
most five checks, one minute apart. Long provider rate-limit hints defer work.
No tokens, raw provider errors or request headers are emitted.

Each invocation holds `<canonical-db-path>.worker-lock/owner.json` with UUID/PID;
its modification time is the heartbeat. An existing lock means busy, regardless
of age. After process death, inspect PID/process and stored attempts. **Only after
confirming the previous worker is stopped**, an operator may remove that exact lock
directory. Lock age alone is not authorization. Never remove an active lock. A
stale-lock recovery does not authorize retrying an ambiguous external write.

## Validation status

Deterministic tests exercise API contracts, ownership, approval, hash integrity and
crash recovery. Live account validation, UI approval, direct upload and publication,
Meta readback, browser playback and a duplicate-prevention rerun succeeded on
2026-10-04 UTC. Media ID: `18473362021119016`.
See `docs/research/native-instagram-live-validation.md` for sanitized evidence.

Approval does not automatically launch this one-shot worker. A dispatcher/timer
is not part of this slice; invoke the command explicitly after the item is due.

Official references: [publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing),
[resumable uploads](https://developers.facebook.com/documentation/instagram-platform/content-publishing/resumable-uploads).
