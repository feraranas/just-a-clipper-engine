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

To process one publicly accessible YouTube video without adding it to the
private playlist or using Google playlist OAuth, pass its URL directly:

```console
npm run audiogram:url -- --url 'https://www.youtube.com/watch?v=VIDEO_ID'
```

The direct-URL command keeps the configured selection behavior, records work
in the local Audiograms ledger, renders through the existing Remotion treatment,
and adds completed files to the local approval queue. It prints one versioned
JSON result to stdout; tool diagnostics go to stderr. A structured terminal
result (`complete`, `no_clips`, or `failed`) exits with status 0 so callers can
read its JSON status; command-line usage errors exit with status 2. Required
media tools remain Node.js 22, yt-dlp, FFmpeg, and ffprobe.

For local ChatGPT Developer Mode testing, see
[`plugins/audiogram-helper/README.md`](plugins/audiogram-helper/README.md) and
start the loopback-only MCP service with `npm run audiogram:mcp`. Connect it
through the Secure MCP Tunnel; this development bridge does not expose a
public endpoint or publish rendered clips.

To evaluate transcript-derived candidates with Jev, provide both Typesafe
settings. This is opt-in; omitting them leaves the existing transcript
selector behavior unchanged:

```console
AUDIOGRAM_CLIP_SELECTOR=transcript-llm \
AUDIOGRAM_LLM_PROVIDER=chatgpt-oauth \
TYPESAFE_JEV_ENDPOINT=https://your-typesafe-endpoint.example/v1/judge \
TYPESAFE_JEV_API_KEY=... \
npm run youtube:inbox
```

To re-authorize YouTube after an expired or revoked Google token:

```console
npm run youtube:login
```

Open the printed URL, complete Google authorization, then rerun
`npm run youtube:inbox`. The command replaces the token only after a successful
callback and stores it at `AUDIOGRAM_GOOGLE_TOKEN_PATH` or the default
application-support path.

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

The local approval queue uses the shared ledger at
`~/Library/Application Support/Audiogram Inbox/instagram-publishing.sqlite`.
Run `node scripts/publishing-server.mjs` and open `http://127.0.0.1:8787/` to
review rendered artifacts. Local queueing uses the account ID `local-approval`
unless `INSTAGRAM_ACCOUNT_ID` is explicitly configured.

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
