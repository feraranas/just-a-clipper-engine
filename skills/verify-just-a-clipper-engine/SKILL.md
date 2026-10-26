---
name: verify-just-a-clipper-engine
description: Prove Audiogram Inbox (just-a-clipper-engine) behavior by driving its real Remotion render CLI on the committed synthetic classic-v1 fixture, offline and without OAuth, and checking the MP4 against the fixture manifest. Use when you must show that the audiogram template still renders, or as the base for driving the URL pipeline and local approval UI.
---

# Verify just-a-clipper-engine

Surfaces (from README, `package.json` scripts and `scripts/`):

- **Primary:** the audiogram renderer, the Remotion composition `AudiogramBasic` (`src/`), invoked by every pipeline and directly through `remotion render`. Driven here.
- Pipelines: `npm run audiogram:url -- --url <youtube-url>` and `npm run youtube:inbox`. They need yt-dlp/YouTube, and, for the default `transcript-llm` selector, an LLM provider (OpenAI API key or ChatGPT OAuth).
- Local approval UI: `node scripts/publishing-server.mjs` on `http://127.0.0.1:8787/` (`PORT`), backed by the SQLite ledger.
- Instagram publishing: `npm run publishing:run -- --item ID --live`. This is a real external post; never drive it for verification.
- MCP helper: `npm run audiogram:mcp`.

All driving goes through `scripts/clipctl`, which resolves its own real path (works from `skills/`, `.cursor/skills/` or `.claude/skills/`).

## Launch

```bash
export RUN_ID=$(date +%s)        # state in /tmp/verify-clipper-$RUN_ID
skills/verify-just-a-clipper-engine/scripts/clipctl launch
```

Runs `npm ci` if `node_modules/.bin/remotion` is missing. Then it stages the synthetic fixture (`tests/fixtures/classic-v1/{audio.wav,thumbnail.svg,captions.json}`) into `public/generated/verify-$RUN_ID/` and writes `$STATE/props.json` (the fixture's `props.json` repointed there). The staged dir is verification scaffolding under the gitignored `public/generated/`; cleanup removes it. Ready = `READY state=... staged=...`. Short-lived CLI: no server to keep alive.

## Doctor

```bash
skills/verify-just-a-clipper-engine/scripts/clipctl doctor
```

Read-only. All `OK`: remotion CLI present, `@remotion/cli` is 4.0.525 (the manifest pin), ffmpeg/ffprobe on PATH, fixture staged, `remotion compositions` lists `AudiogramBasic`. It also prints the Node version (README requires 22), the browser in use and repo HEAD.

## Drive

```bash
skills/verify-just-a-clipper-engine/scripts/clipctl journey render-classic-fixture
```

Runs the README's documented render command: `remotion render AudiogramBasic <out> --props=<props> --frames=0-179 --concurrency=1 --codec=h264`. It adds `--browser-executable=$CHROME_PATH` when a system Chrome exists; otherwise Remotion downloads its own headless shell. Then it probes and checks the output against `tests/fixtures/classic-v1/baseline-manifest.json`: 1080×1920, 30 fps, 180 frames, h264, audio stream present.

Other features: [features/README.md](features/README.md).

Isolation: everything is keyed by `RUN_ID` (`/tmp/verify-clipper-$RUN_ID`, `public/generated/verify-$RUN_ID`), so parallel runs do not collide. `launch` refuses to reuse a staged dir.

## Evidence

`skills/verify-just-a-clipper-engine/evidence/$RUN_ID/render-classic-fixture/`: `command.txt`, `exit-code.txt`, `render-log.txt` (progress lines stripped), `ffprobe.json`, `checks.json` (per-check booleans + `pass`), `audio-hash.txt` (sha256 of decoded audio), `frame-0.png`/`frame-90.png`/`frame-179.png` (540 px wide), and `candidate.mp4` (about 0.5 MB).

Proof standards: this drives the real CLI on committed synthetic input. Nothing is mocked. External calls: Remotion may fetch IBM Plex Sans from `fonts.gstatic.com` (read-only), and downloads Chrome Headless Shell if no system Chrome is given. No OAuth, LLM, YouTube or Instagram calls. Frame-exact parity (`scripts/verify-classic-parity.mjs`) needs `out/classic-regression/baseline.mp4`, which is local-only and not in git, so parity is not checked. A system Chrome also differs from the manifest's "Chrome Headless Shell 149". Committed reference proof: `evidence/final/`.

## Cleanup

```bash
skills/verify-just-a-clipper-engine/scripts/clipctl cleanup
```

Removes only `public/generated/verify-$RUN_ID` and `/tmp/verify-clipper-$RUN_ID`; no processes outlive the render. Evidence is kept.

## Helpers

- `scripts/clipctl launch | doctor | journey render-classic-fixture | cleanup` (env `RUN_ID`, `CHROME_PATH`, optional `CLIP_VERIFY_STATE`, `CLIP_VERIFY_EVIDENCE`).

## Maintenance

Use `/maintain-verification-skill` to keep `features/` in step with the app. This skill is verification tooling only; behavior changes still follow the repo's `feature-flow-diagrams` workflow in `AGENTS.md`.
