# Audiogram Inbox verification map

This directory is the maintained source for verifying user-facing behavior of just-a-clipper-engine.

## Baseline preconditions

- `clipctl launch` printed `READY`; `clipctl doctor` all `OK`.
- No OAuth tokens, LLM keys or Instagram credentials in the environment unless a feature explicitly requires and the user approved them.
- For anything that writes the ledger, set `AUDIOGRAM_DATA_ROOT` to an absolute scratch dir (for example `$STATE/data`) so the real `~/Library/Application Support/Audiogram Inbox/` ledger is never touched.

## Proof and skip reporting

- CLI proof = command, exit code, log, plus a second view of the output (ffprobe, extracted frames, ledger rows, `/api/items`).
- Never run `publishing:run --live`, `youtube:login`, `chatgpt:login` or `test:selector:live` for verification. Report those paths as unverified.

## Features

- [Render audiogram template](./render-template.md): `remotion render AudiogramBasic` on the classic-v1 fixture. **Proved.**
- [Direct-URL pipeline](./audiogram-url.md): `npm run audiogram:url -- --url ...`.
- [Playlist inbox pipeline](./youtube-inbox.md): `npm run youtube:inbox`.
- [Local approval UI](./approval-ui.md): `publishing-server.mjs` on :8787.
- [Instagram publishing](./instagram-publish.md): `publishing:run --live`. Never drive.
