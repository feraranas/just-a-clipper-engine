# Instagram scheduled dispatcher

`npm run publishing:dispatch -- --live` is an opt-in, separately started process that polls the publishing ledger every 60 s and calls the one-item publishing worker for approved items whose `scheduledAt` has passed (and safely resumable in-flight attempts). A running dispatcher can publish a real post without another manual command. Never start it with credentials for verification.

## Sub-features

- `dispatch-guard` any argv other than exactly `--live` → `{"status":"stopped","errorCode":"DISPATCH_LIVE_FLAG_REQUIRED"}`, exit 1.
- `dispatch-config` `--live` with missing or invalid `INSTAGRAM_*` config (including `INSTAGRAM_USERNAME`) or a missing publishing DB → `{"status":"stopped","errorCode":"DISPATCH_CONFIGURATION_ERROR"}`, exit 1; the ledger is not created.
- `dispatch-loop` passes pick only configured-account items in `approved`/`uploading`/`container_created`/`processing` that are due; failed, unknown, rejected or published items are never selected. Covered only by fakes.

## How to get to it (user POV)

- `npm run publishing:dispatch -- --live`, with the Instagram env from `.env.example` and an existing publishing DB.

## Driving it with clipctl

Preconditions:

- No `INSTAGRAM_*` variables and no `.env`; `AUDIOGRAM_DATA_ROOT=$STATE/data`.

- **Guard.** `node scripts/publishing-dispatcher.mjs` → the `DISPATCH_LIVE_FLAG_REQUIRED` line, exit 1.
- **Config.** `node scripts/publishing-dispatcher.mjs --live` → `DISPATCH_CONFIGURATION_ERROR`, exit 1.
- **Never** run `--live` with real or fake-but-plausible credentials against a real ledger. The scheduling logic is proved only by `node --test scripts/publishing-dispatcher.test.mjs` (fixtures and a fake Meta client; developer signal, not user-path proof).

## Gotchas

- Both guard outputs appear with an `ExperimentalWarning` for SQLite on stderr; stdout is the single JSON line.
