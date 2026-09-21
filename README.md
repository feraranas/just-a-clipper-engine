# Audiogram Inbox

Audiogram Inbox turns strong moments from videos in a private playlist into
reusable clip packages and rendered Remotion artifacts. YouTube Most Replayed
heatmap selection remains the default; complete-transcript selection is an
explicit opt-in.

V1 registers one treatment, `audiogram-basic@1`, but discovery, package assets,
the SQLite ledger, and the renderer are treatment-independent.

## Run the MVP

Prerequisites:

- Node.js 22
- yt-dlp
- FFmpeg and ffprobe
- A Google desktop OAuth client authorized for read-only YouTube access

Install locked dependencies and run the pipeline:

```console
npm ci
npm run youtube:inbox
```

On first authorization, open the printed Google OAuth URL. The pipeline looks
for a private playlist named `Audiogram Inbox` by default.

## Transcript selector providers

Transcript selection must name exactly one provider and never falls back to a
different provider. A provider failure therefore cannot spend another
provider's quota or create billing on another account.

Use an official OpenAI API key:

```console
AUDIOGRAM_CLIP_SELECTOR=transcript-llm \
AUDIOGRAM_LLM_PROVIDER=openai-api \
OPENAI_API_KEY=... \
npm run youtube:inbox
```

Or create dedicated ChatGPT OAuth credentials, then select the unofficial
adapter explicitly:

```console
npm run chatgpt:login
AUDIOGRAM_CLIP_SELECTOR=transcript-llm \
AUDIOGRAM_LLM_PROVIDER=chatgpt-oauth \
npm run youtube:inbox
```

The ChatGPT OAuth integration is unofficial and may break when the ChatGPT
Codex backend changes. Login uses only the package's exported login function;
generation uses the pinned core transport directly. The project does not run
the package proxy, CLI, or update check, and it does not discover or share
Codex CLI credentials. Login and refresh persist an atomic, app-owned credential
file at
`~/Library/Application Support/Audiogram Inbox/chatgpt-oauth/auth.json` by
default (`0700` parent, `0600` regular file).

Do not run login, the selector smoke test, or transcript pipeline processes
concurrently. The current guard serializes credentials only inside one process;
PR6 will add the cross-process lease.

### Explicitly authorized live smoke

The smoke command is inert by default:

```console
npm run test:selector:live
# live smoke test not authorized
```

It performs one real request only when the operator deliberately sets
`AUDIOGRAM_RUN_LIVE_SELECTOR_SMOKE=1` and supplies one provider's authentication:

```console
AUDIOGRAM_RUN_LIVE_SELECTOR_SMOKE=1 \
AUDIOGRAM_LLM_PROVIDER=openai-api \
OPENAI_API_KEY=... \
npm run test:selector:live
```

For ChatGPT OAuth, run `npm run chatgpt:login` first, replace the provider with
`chatgpt-oauth`, and omit `OPENAI_API_KEY`. The request uses a fixed synthetic
transcript with three production-valid arcs plus the production prompt, schema,
recipe, deadlines, resource caps, and response extractor. It never touches the
playlist, ledger, media, or Remotion. Output is limited to provider ID, model,
recipe hash, response ID, schema version, clip count, and pass/fail.

## Verify development changes

```console
npm run test:youtube
npm run lint
npx remotion compositions
```

Open the composition interactively:

```console
npm run dev
```

## Runtime outputs

Clip packages are generated under:

```text
public/generated/<video-id>/<package-version>/clip-<rank>/
```

Rendered treatment artifacts are published under:

```text
out/treatments/<treatment-id>/<treatment-version>/<video-id>/<package-version>/
```

Both directories are ignored by Git. OAuth credentials and the SQLite ledger
live in `~/Library/Application Support/Audiogram Inbox/` and must not be
committed.

The default workflow downloads only the selected audio interval. It never
silently falls back to downloading the full video. V1 uses YouTube creator or
automatic captions only; local Whisper is planned for V2.

The locked dependency audit currently has eight low-severity findings and no
moderate, high, or critical findings. See
[OpenAI OAuth dependency provenance](docs/OPENAI_OAUTH_PROVENANCE.md) for the
installed-package boundary and residual warning context.

## Documentation

- [Project status and operational handoff](docs/PROJECT_STATUS.md)
- [Generic package and treatment design](docs/superpowers/specs/2026-09-18-clip-package-treatment-registry-design.md)
- [Implementation plan](docs/superpowers/plans/2026-09-18-clip-package-treatment-registry.md)

## Remotion licensing

This project derives from Remotion's Audiogram template. Review the
[Remotion license](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md)
for applicable commercial terms.
