# Instagram publishing

`npm run publishing:run -- --item ID --live` publishes an approved item to Instagram; `--check-account` checks the configured account.

## Sub-features

- `publish-live` posts the item. This is a real external side effect.
- `publish-check` account check (calls the Instagram Graph API with the configured token).
- `publish-guard` bad arguments or missing `INSTAGRAM_*` config stop before any network call.

## How to get to it (user POV)

- `npm run publishing:run -- --item <id> --live`

## Driving it with clipctl

Preconditions:

- No `INSTAGRAM_*` variables in the environment and no `.env` in the checkout.

- **Guard.** `AUDIOGRAM_DATA_ROOT=$STATE/data node scripts/publishing-run.mjs --item <id>` (no `--live`) → stdout `{"status":"stopped","errorCode":"CONFIGURATION_OR_WORKER_ERROR"}`, exit 1. `--check-account` without config prints the same. The usage text is not shown.
- **Never `--live`.** Use the unit tests (`npm run test:publishing`, which use fakes) only as a developer signal, not as user-path proof.

## Gotchas

- `publish-live` and `publish-check` are unverifiable by policy without explicit user approval and credentials.
