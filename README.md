# Audiogram Inbox

Audiogram Inbox turns strong moments from videos in a private playlist into
reusable clip packages and rendered Remotion artifacts. Complete-transcript
`transcript-llm` selection is the default and requires an explicit provider;
YouTube Most Replayed `youtube-heatmap` selection remains available as an
explicit compatibility option.

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

Because transcript selection is the default, configure one of the providers
described below before running the command. To use the compatibility selector,
set `AUDIOGRAM_CLIP_SELECTOR=youtube-heatmap` explicitly.

For local ChatGPT Developer Mode testing, see
[`plugins/audiogram-helper/README.md`](plugins/audiogram-helper/README.md) and
start the loopback-only MCP service with `npm run audiogram:mcp`. Connect it
through the Secure MCP Tunnel; this development bridge does not expose a
public endpoint or publish rendered clips.

Jev reranking is opt-in. Without both Typesafe settings, transcript-LLM ranks
its generated candidates without Jev:

```console
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
AUDIOGRAM_LLM_PROVIDER=openai-api \
OPENAI_API_KEY=... \
npm run youtube:inbox
```

Or create dedicated ChatGPT OAuth credentials, then select the unofficial
adapter explicitly:

```console
npm run chatgpt:login
AUDIOGRAM_LLM_PROVIDER=chatgpt-oauth \
npm run youtube:inbox
```

The selector can be omitted for both provider examples because
`transcript-llm` is the default. Set `AUDIOGRAM_CLIP_SELECTOR=youtube-heatmap`
only when intentionally using the compatibility selector.

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

## Select a video template

The current design is **Classic V1 / Default**. It preserves the existing portrait layout at 1080x1920 and 30 fps.
Omit template fields to use Classic / Default.

```console
npm run audiogram:url -- --url 'https://www.youtube.com/watch?v=VIDEO_ID' --template classic --template-version 1 --variation default
```

The playlist pipeline accepts these environment settings:

```sh
AUDIOGRAM_TEMPLATE=classic
AUDIOGRAM_TEMPLATE_VERSION=1
AUDIOGRAM_VARIATION=default
```

Explicit CLI fields take precedence over environment values. Unknown or empty choices fail before acquisition.
Visual choices do not change the clip-selection recipe.
Studio groups the existing `AudiogramBasic` composition under **Classic**.
The internal treatment remains `audiogram-basic@1`, so historical paths and completed renders remain compatible.

New renders include `clip-N.manifest.json` beside their MP4 and props file.
The manifest records the selection, treatment, composition, props and MP4 hash.
Historical MP4s do not require a manifest.
A request fails if any selected clip lacks a verified MP4, but returns paths for the valid files.

To add a future template:

1. Define its composition and schema.
2. Add a catalog entry in `src/templates/catalog.mjs`.
3. Register a distinct versioned treatment in `scripts/treatment-registry.mjs`.
4. Define the required assets and props builder.
5. Add a regression fixture and inspect a local preview.
6. Check job identity, output isolation and result collection.

Classic's defaults live in `src/templates/classic/defaults.json`.
Do not change those values for a new template.
Square output and Editorial are not available in this release.
See [the feature contract](docs/features/classic-template-selection.md) and [the synthetic fixture](tests/fixtures/classic-v1/README.md).
