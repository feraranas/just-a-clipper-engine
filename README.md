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

Optional MCP Events uses the same SQLite job store and stage logger. Set
`AUDIOGRAM_MCP_EVENTS_ENABLED=1` and explicitly select
`AUDIOGRAM_MCP_EVENTS_MODE=private-tunnel` for a private development tunnel.
Supply `AUDIOGRAM_EVENT_SECRET_KEY` securely at runtime: a persistent base64
encoding of 32 random bytes. Do not put a real key in Git, chat, or command
arguments. Keep it stable across restarts; replacing it makes stored callback
secrets and cursors unreadable. Key rotation needs a separate migration.

Both modern discovery and legacy initialization then advertise Events. The same
MCP endpoint exposes `events/list`, `events/subscribe`, and
`events/unsubscribe`. Clients subscribe by job ID to `audiogram.job.progress`
or `audiogram.job.finished`. The server verifies the signed callback before
activation, encrypts its secret, and resumes pending delivery after restart.
Safe job status includes capture health, delivery health, and subscription IDs.
This change does not update the remote plugin or prove ChatGPT presentation.

`shared` mode requires a trusted authenticated `principalResolver` supplied to
`startMcpServer`; it cannot be enabled safely through the CLI alone. Existing
ownerless jobs require an explicit owner migration in shared mode. Private
tunnel mode assigns these jobs to `local-owner`; do not use that mode for
multiple users. No owner field is accepted in public tool arguments.

Start the service visibly with `npm run audiogram:mcp`; stop it with Ctrl-C.
Shutdown stops new claims, aborts callback requests, waits for the dispatcher,
and closes its store. Notification failures never retry processing or change a
render result. A successful HTTP receipt does not prove ChatGPT displayed it.

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


### Retry a failed render

Use the same URL and template selection with the explicit retry option:

```sh
npm run audiogram:url -- --url "https://www.youtube.com/watch?v=VIDEO_ID" --template classic --template-version 1 --variation default --retry-failed-renders
```

The option retries failed renders for that video and template when their clip
assets are ready. Completed renders remain unchanged. A normal request does
not retry failed renders. Each reset saves the previous error and retry time
in `treatment_run_retries`. Another failure requires another explicit retry.

This option is available through the single-URL CLI. It does not retry asset
acquisition failures, restore missing completed videos, or publish videos.
Do not run concurrent requests for the same video. The existing renderer has
no cross-process claim for a pending render.


### Shared storage and worktree cleanup

Accepted videos are stored outside the source checkout. All production consumers
use the same shared storage configuration. Defaults are:

| Data | Default under ~/Library/Application Support/Audiogram Inbox |
|---|---|
| Processing ledger | audiograms.sqlite |
| Publishing queue ledger | instagram-publishing.sqlite |
| Accepted videos and manifests | artifacts/<video-hash>/<manifest-hash>/ |
| Pipeline log | pipeline.jsonl |

Set AUDIOGRAM_DATA_ROOT to an absolute directory to move these defaults together.
AUDIOGRAM_ARTIFACT_ROOT selects an alternate absolute artifact reference root.
It must be outside the checkout used for rendering. The processing and publishing
DB overrides remain AUDIOGRAM_DB_PATH and INSTAGRAM_PUBLISHING_DB_PATH.
PUBLISHING_DB is a legacy alias. Conflicting alias values fail configuration.
Use the same configuration for the CLI, helper, queue server and publishing worker.

The CLI returns durable references beginning with `artifacts/`. Resolve these
under the configured artifact root. Intermediates, original input assets and
props remain in the producing checkout. The accepted video and its manifest
survive removal of that checkout. The copied manifest records input hashes;
it does not archive the original inputs for a future rerender.

Older out/... records still require their original checkout until migrated.
Preview errors now identify missing files. Migration does not delete source files,
change approvals or publish videos. Inspect a migration first:

```sh
npm run artifacts:migrate -- --source-root /absolute/path/to/original/checkout
```

Apply verified moves after the queue server and all consumers use this version:

```sh
npm run artifacts:migrate -- --source-root /absolute/path/to/original/checkout --apply
```

You may supply several --source-root options, including an archive backup root.
Only bytes matching saved publishing hashes can move a queue record. If a source
is missing or changed, migration reports it and leaves that record unresolved.
Legacy files without manifests get an explicit legacy-import record with unknown
input hashes. Migration checkpoints support reruns after interrupted DB updates.
Historical helper job results are not rewritten by this command; their old paths
still need the original checkout. New helper jobs use durable references.
