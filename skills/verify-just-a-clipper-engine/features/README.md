# Audiogram Inbox verification map

This directory is the maintained source for verifying user-facing behavior of just-a-clipper-engine.

## Baseline preconditions

- `clipctl launch` printed `READY`; `clipctl doctor` all `OK`. `launch` reinstalls dependencies when `package-lock.json` is newer than `node_modules/` (for example after `git pull`).
- Node >= 22.13 for everything except the render feature. The pipelines, approval UI and MCP helper import `node:sqlite`; on Node 20 they crash with `ERR_UNKNOWN_BUILTIN_MODULE`. `doctor` prints a `WARN` line in that case.
- No OAuth tokens, LLM keys or Instagram credentials in the environment unless a feature explicitly requires and the user approved them.
- For anything that writes the ledger, set `AUDIOGRAM_DATA_ROOT` to an absolute scratch dir (for example `$STATE/data`) so the real `~/Library/Application Support/Audiogram Inbox/` ledger is never touched. For MCP jobs also set `AUDIOGRAM_DIAGNOSTICS_ROOT` (default is `.local/audiogram-helper/runs/` in the checkout).

## Proof and skip reporting

- CLI proof = command, exit code, log, plus a second view of the output (ffprobe, extracted frames, ledger rows, `/api/items`).
- Never run `publishing:run --live`, `youtube:login`, `chatgpt:login` or `test:selector:live` for verification. Report those paths as unverified.

## Features

- [Render audiogram template](./render-template.md): `remotion render AudiogramBasic` on the classic-v1 fixture. **Proved.**
- [Direct-URL pipeline](./audiogram-url.md): `npm run audiogram:url -- --url ...`. **Proved** with the heatmap selector.
- [Playlist inbox pipeline](./youtube-inbox.md): `npm run youtube:inbox`. Needs the user's Google OAuth; only the missing-credentials path is driven.
- [Local approval UI](./approval-ui.md): `publishing-server.mjs` on :8787. **Proved** (API level).
- [Instagram publishing](./instagram-publish.md): `publishing:run --live`. Never drive; only argument/config guards are driven.
- [MCP helper](./mcp-helper.md): `npm run audiogram:mcp` on `127.0.0.1:7331/mcp`. **Proved** with the heatmap selector.
- [Template sample server](./template-samples.md): `npm run samples:render` / `npm run samples:serve` on :8790. Serve proved on a seeded registry; render needs macOS `say`.
