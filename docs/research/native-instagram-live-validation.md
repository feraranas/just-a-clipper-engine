# Native Instagram live validation — 2026-10-04 UTC

## Result

Published one approved Reel directly through Meta, without Upload-Post:
https://www.instagram.com/reel/DeD3OMejxCE/

- Account: `theballooninquiries` (`17841411025933729`)
- Linked Page: `1367664856427450`
- Graph API: `v26.0`
- Item: `f62104d9-097b-42ae-922c-234e5d1d8534`
- Artifact: `sha256:d720367a475defbc687ddd8db935e9af7ad2d2287beb84d0db487f36b41d1570`
- Caption: `instagram test caption first time`
- Container: `18187325362367532`
- Published media: `18473362021119016`
- Attempt: `b39920b8-6a4a-4b4e-a97b-20014c5bf55e`
- Meta timestamp: `2026-10-04T05:17:09+0000`
- Local published commit: `2026-10-04T05:17:15.671Z`

## Authorization and environment

User explicitly selected the artifact and caption, authorized using the existing
App Support database instead of an isolated database, authorized Node loading the
existing `.env` by path without displaying/copying/modifying its contents, and
approved the item through the updated dashboard. The original record used
`local-approval`; with explicit permission it was moved to the real account and
returned to queued before fresh approval. No credential values are recorded here.

Code ran from `/Users/kiwi/.codex/worktrees/native-instagram-publishing/Audiograms`
on `codex/native-instagram-publishing`, implementation commit `7da318f`.
The dashboard on 8787 was restarted with this branch's server/ledger/UI code and
the original checkout's artifact root. Main's source and untracked files were
not modified. Opening the existing DB applied the approved additive migration.

## Observed sequence

1. Saved UI approval readback: state `approved`, correct account, matching artifact
   and approved hash, matching caption and approved caption. Scheduled time
   `2026-10-04T05:15:00.000Z`; approval `2026-10-04T05:15:26.249Z`. Due at run time.
2. `--check-account` returned `account_verified` for the Page and Instagram account.
3. `ffprobe`: MP4, H264 1080x1080 30 fps, AAC, 90.048 seconds, 9,492,168 bytes.
   The selected square artifact was not re-rendered or reframed.
4. One-shot command created a container, streamed MP4, polled readiness and
   published. Live DB observation captured `upload_requested` at
   `2026-10-04T05:16:44.580Z`; worker exited 0 with `published` and media ID.
5. Read-only Meta media queries returned the ID/permalink, exact caption, username,
   `media_type: VIDEO`, `media_product_type: REELS` and publication timestamp.
6. Opened permalink in browser: account, caption and selected audiogram visually
   matched. Playback observation: currentTime 36.049014, duration 90,
   paused false, readyState 4, encoded display dimensions 720x720. Audio was muted;
   audible playback quality was not evaluated.
7. Reran identical CLI for the same item: exit 0, same media ID. Existing published
   records return before client calls. DB still contained one attempt, phase
   `published`, retry_count 1. No second post or replacement container was created.

## Commands

Run from the feature worktree; env-file contents are consumed only by Node:

```sh
node --env-file=/Users/kiwi/repositories/internal/remotion-projects/Audiograms/.env \
  scripts/publishing-run.mjs --check-account

node --env-file=/Users/kiwi/repositories/internal/remotion-projects/Audiograms/.env \
  scripts/publishing-run.mjs \
  --db '/Users/kiwi/Library/Application Support/Audiogram Inbox/instagram-publishing.sqlite' \
  --project-root /Users/kiwi/repositories/internal/remotion-projects/Audiograms \
  --item f62104d9-097b-42ae-922c-234e5d1d8534 --live
```

## Boundaries and remaining work

This validates one account/artifact and one-shot execution, not automatic dispatch
or wakeup at scheduled time. No daemon was installed, no token expiry was inferred,
no uncertain write was retried, and the test post was not deleted.
Previous full-suite testing reported one unchanged OAuth smoke failure with elevated
credential access; it passed sandboxed. That separate limitation is not evidence of
a publishing failure and must not be silently reported as a green full suite.
