# Instagram publishing

`npm run publishing:run -- --item ID --live` publishes an approved item to Instagram; `--check-account` checks the configured account.

## Sub-features

- `publish-live` posts the item. This is a real external side effect.
- `publish-check` read-only account check (calls the Instagram API).

## How to get to it (user POV)

- `npm run publishing:run -- --item <id> --live`

## Driving it with clipctl

Preconditions:

- None. Do not drive.

- **Never.** Verification must not run `--live`. Use the unit tests (`npm run test:publishing`, which use fakes) only as a developer signal, not as user-path proof.

## Gotchas

- Unverifiable by policy without explicit user approval of a real post.
