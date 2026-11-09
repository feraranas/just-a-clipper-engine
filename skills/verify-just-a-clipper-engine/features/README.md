# Audiogram Inbox verification map

This directory is the maintained source for verifying user-facing behavior of just-a-clipper-engine.

## Baseline preconditions

- `clipctl launch` printed `READY`; `clipctl doctor` all `OK`. `launch` reinstalls dependencies when `package-lock.json` is newer than `node_modules/` (for example after `git pull`).
- Node >= 22.13 for everything except the render feature. The pipelines, approval UI and MCP helper import `node:sqlite`; on Node 20 they crash with `ERR_UNKNOWN_BUILTIN_MODULE`. `doctor` prints a `WARN` line in that case.
- No OAuth tokens, LLM keys or Instagram credentials in the environment unless a feature explicitly requires and the user approved them.
- For anything that writes the ledger, set `AUDIOGRAM_DATA_ROOT` to an absolute scratch dir (for example `$STATE/data`) so the real `~/Library/Application Support/Audiogram Inbox/` ledger is never touched. For MCP jobs also set `AUDIOGRAM_DIAGNOSTICS_ROOT` (default is `.local/audiogram-helper/runs/` in the checkout).

## Proof and skip reporting

- CLI proof = command, exit code, log, plus a second view of the output (ffprobe, extracted frames, ledger rows, `/api/items`).
- Never run `publishing:run --live`, `publishing:dispatch --live`, `publishing-recover.mjs --apply` against a real ledger, `youtube:login`, `chatgpt:login` or `test:selector:live` for verification. Report those paths as unverified.

## Features

- [Render audiogram template](./render-template.md): `remotion render AudiogramBasic` on the classic-v1 fixture. **Proved.**
- [Direct-URL pipeline](./audiogram-url.md): `npm run audiogram:url -- --url ...`. **Proved** with the heatmap selector when YouTube allows caption downloads (a 429 on 2026-11-09 failed it at `assets`).
- [Playlist inbox pipeline](./youtube-inbox.md): `npm run youtube:inbox`. Needs the user's Google OAuth; only the missing-credentials path is driven.
- [Local approval UI](./approval-ui.md): `publishing-server.mjs` on :8787, including per-item attempt history and the `Debug jobs` link (the System logs panel is gone). **Proved** (API, plus page screenshots with `scripts/ui-shot.mjs`).
- [Instagram publishing](./instagram-publish.md): `publishing:run --live`. Never drive; only argument/config guards are driven.
- [Instagram upload recovery](./instagram-recovery.md): `node scripts/publishing-recover.mjs --item ID [--apply ...]`. Guards and offline inspect codes proved with network blocked; eligible inspect and apply need a real failed upload.
- [MCP helper](./mcp-helper.md): `npm run audiogram:mcp` on `127.0.0.1:7331/mcp`, modern protocol `2026-07-28` plus stateless legacy clients. **Proved** with the heatmap selector, on both eras.
- [Job debug console](./job-debug-console.md): `/debug/jobs` and `/api/debug/*` on the publishing server (`npm run debug:serve`). **Proved** on a real failed job (API plus page screenshot), the missing-source guard, and the fixture browser check; delivery rows need a real ChatGPT subscription.
- [Instagram dispatcher](./instagram-dispatcher.md): `npm run publishing:dispatch -- --live`. Never drive live; only the argument/config guards are driven.
- [Explainer workflow](./explainer-workflow.md): `candidates:review`, `explainer`, five MCP tools and the presenter/`AnimatedExplainer` compositions. Guards, tool listing, scene blocks and composition registry driven; the generation chain is unverified (needs a saved review plus LLM/Jev/ElevenLabs credentials and local artwork).
- [Template sample server](./template-samples.md): `npm run samples:render` / `npm run samples:serve` on :8790. Serve proved on a seeded registry; render needs macOS `say`.
