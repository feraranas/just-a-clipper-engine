# Playlist inbox pipeline

`npm run youtube:inbox` syncs a private YouTube playlist through Google OAuth, then processes each new video like the direct-URL pipeline.

## Sub-features

- `inbox-auth` uses the stored Google token; `youtube:login` re-authorizes.
- `inbox-sync` discovers new playlist videos.
- `inbox-logs` writes stage events to `pipeline.jsonl`, shown by `npm run audiogram:logs` and the approval UI activity panel.

## How to get to it (user POV)

- `npm run youtube:inbox`

## Driving it with clipctl

Preconditions:

- A Google OAuth token for the user's private playlist. clipctl does not provide one.

- **Not drivable offline.** Requires the user's OAuth and private playlist.

## Gotchas

- Not proved. Never run `youtube:login` from an agent; it opens a browser OAuth flow for the user's account.
