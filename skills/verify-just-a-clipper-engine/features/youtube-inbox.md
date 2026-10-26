# Playlist inbox pipeline

`npm run youtube:inbox` syncs a private YouTube playlist through Google OAuth, then processes each new video like the direct-URL pipeline.

## Sub-features

- `inbox-auth` reads the OAuth client (`AUDIOGRAM_GOOGLE_CLIENT_PATH`, default `~/Library/Application Support/Audiogram Inbox/google-oauth-client.json`) and stored token (`AUDIOGRAM_GOOGLE_TOKEN_PATH`); with a client but no token it starts a local OAuth callback flow. `youtube:login` re-authorizes.
- `inbox-sync` discovers new playlist videos (`AUDIOGRAM_YOUTUBE_PLAYLIST`, default `Audiogram Inbox`).
- `inbox-logs` writes stage events to `$AUDIOGRAM_DATA_ROOT/pipeline.jsonl` (`AUDIOGRAM_PIPELINE_LOG_PATH`), shown by the approval UI activity panel (`/api/logs`). `npm run audiogram:logs` is a different log: per-job MCP diagnostics ([mcp-helper](./mcp-helper.md)).

## How to get to it (user POV)

- `npm run youtube:inbox`

## Driving it with clipctl

Preconditions:

- Node >= 22.13. A real run needs the user's OAuth client and token for the private playlist. clipctl does not provide them.

- **Missing credentials.** `HOME=$STATE/home AUDIOGRAM_DATA_ROOT=$STATE/data AUDIOGRAM_CLIP_SELECTOR=youtube-heatmap node scripts/youtube-pipeline.mjs` → exit 1, `ENOENT ... google-oauth-client.json` (uncaught stack trace); `$STATE/data/pipeline.jsonl` gets `pipeline` `started` then `failed` (`operation_failed`). `HOME` is scratch because the script creates `~/Library/Application Support/Audiogram Inbox/`.
- **Sync.** Not drivable offline: needs the user's OAuth and private playlist.

## Gotchas

- Never run `youtube:login` from an agent, and never give the inbox a client file without a token: both open a browser OAuth flow for the user's account.
