# Audiogram Inbox: Project Status and Handoff

Last updated: 2026-09-20

This is the shared handoff for humans and coding agents. Update it whenever a
durable pipeline stage or its operational behavior changes.

## Outcome

The V1 MVP is implemented and verified end to end for the default YouTube Most
Replayed path. Videos added to the private playlist `Audiogram Inbox` are
imported, packaged without a full-video download, and rendered through an
explicit Remotion treatment. PR5 also adds an explicitly selected complete-
transcript selector with official OpenAI API and unofficial ChatGPT OAuth
providers. Its offline contract is verified; no live selector smoke request has
been run without separate operator authorization.

V1 exposes one treatment: `audiogram-basic@1`.

```text
YouTube playlist
      |
      v
OAuth importer -> SQLite package job -> selector recipe
                                      /             \
                       heatmap (explicit)     transcript + one provider (default)
                                      \             /
                                       ranked ClipPackage
                                  /       |        \
                             audio    captions   thumbnail
                                  \       |        /
                                           v
                              treatment registry
                                           |
                                           v
                              audiogram-basic@1 MP4
```

The approved architecture is documented in
`docs/superpowers/specs/2026-09-18-clip-package-treatment-registry-design.md`.
The implementation plan is
`docs/superpowers/plans/2026-09-18-clip-package-treatment-registry.md`.

## Implemented behavior

- Google OAuth with read-only YouTube access.
- Paginated import of the private `Audiogram Inbox` playlist.
- Metadata-only yt-dlp heatmap extraction and independent-peak selection.
- Heatmap selection remains the default. Its maximum clip count and minimum
  separation are part of the canonical recipe identity.
- Opt-in complete-transcript selection with deterministic English-track choice,
  strict timing/cue validation, exactly three to five grounded narrative arcs,
  and canonical prompt/schema/provider recipe identity.
- Explicit `openai-api` and `chatgpt-oauth` structured-generation providers
  with no cross-provider fallback, retry, or parallel request fan-out.
- Provider-owned model, endpoint, storage, deadline, and resource limits;
  official requests retain the 4096-token cap and OAuth responses are bounded
  before SSE aggregation.
- App-owned atomic ChatGPT OAuth credentials and bounded refresh/catalog/
  Responses operations. The adapter is unofficial and may break with backend
  changes.
- Explicit SQLite schema version 1 with transactional, fail-closed migration
  from legacy and known unversioned generic ledgers.
- Reusable packages independent of any Remotion composition.
- Multiple ranked packages in the schema and orchestration.
- Partial audio acquisition with `--download-sections`; there is no full-video
  fallback.
- YouTube creator captions first, YouTube automatic captions second, and a
  terminal package failure when neither is available. Local Whisper is not used
  in V1.
- Caption trimming, clamping, and rebasing to package-local timestamps.
- SRT cue normalization into individually timed words so captions wrap
  predictably and progress from waveform gray to white as they are spoken.
- Thumbnail acquisition and conversion to JPEG.
- Audio-duration validation with a three-second tolerance.
- Explicit treatment registry with duplicate and unknown-treatment rejection.
- Generic renderer driven only by treatment registry metadata.
- Dynamic `AudiogramBasic` composition using package title, cover, audio, and
  captions.
- Compact, contained title and caption typography with four-line pagination.
- Private sibling staging, complete package validation, and atomic package
  directory publication, including reuse after a publish-before-ledger crash.
- Temporary render output, non-empty validation, and atomic treatment-artifact
  publication.
- Per-package and per-treatment failure isolation.
- Duplicate-safe reruns across analysis, acquisition, and rendering.

## Persistent data model

The SQLite ledger contains:

- `videos`: canonical YouTube identity and current source metadata.
- `package_jobs`: one heatmap/package-generation job per
  `(video_id, package_version)`.
- `clip_packages`: one ranked interval per `(package_job_id, rank)`.
- `clip_assets`: open asset roles and project-relative paths, with optional
  provenance and metadata.
- `treatment_runs`: one run per
  `(clip_package_id, treatment_id, treatment_version)`.

Package states are `selected`, `ready`, and `failed`. Treatment-run states are
`pending`, `rendered`, and `failed`. A failed treatment never invalidates its
reusable package.

The ledger is schema version `1`, stored in SQLite `PRAGMA user_version`. A
version-zero database is classified transactionally as fresh, legacy-only, or a
complete known generic schema. Known historical generic ledgers receive only the
two previously optional `clip_assets` columns before validation. Ambiguous,
incomplete, malformed, and newer-than-supported schemas fail closed; the version
is stamped only after migration and validation succeed. An already-versioned
schema is validated on open and is never silently repaired.

## Deterministic paths

Generated package assets are runtime files ignored by Git:

```text
public/generated/<video-id>/<package-version>/clip-<rank>/
├── audio.wav
├── captions.json
├── thumbnail.jpg
└── package.json
```

Acquisition writes to a unique sibling such as
`.clip-<rank>.staging-<uuid>/`, validates the whole package and its identity,
then publishes it with one same-filesystem directory rename. If the final
directory already contains a complete matching package, including after a crash
between publication and the SQLite ready transition, the next run reuses it
without reacquisition. An invalid pre-existing final directory causes a bounded
failure and is never overwritten or deleted.

Treatment output is also ignored by Git:

```text
out/treatments/<treatment-id>/<treatment-version>/<video-id>/<package-version>/
├── clip-<rank>.props.json
└── clip-<rank>.mp4
```

The versioned treatment path is canonical for new renders. Historical persisted
artifact paths and files remain valid and are not rewritten or moved
automatically.

## Live verification

The first end-to-end run on 2026-09-18 found two playlist videos.

For `KHd-luu3M8s` (`Your phone addiction is keeping you from achieving flow
state | Arthur Brooks`):

- Migrated package job: `heatmap_ready`.
- Selected interval: `882.2` to `902.25` seconds.
- Package rank: `1`; state: `ready`.
- Assets persisted: `audio`, `captions`, and `thumbnail`.
- Treatment run: `audiogram-basic@1`; state: `rendered`.
- Artifact:
  `out/treatments/audiogram-basic/1/KHd-luu3M8s/clip-1.mp4`.
- This is the historical path recorded by the 2026-09-18 run, before package
  version became part of the canonical treatment output identity.
- Verified corrected artifact size: `2,449,011` bytes.
- Verified artifact duration: `22.314667` seconds.

For `MWvH7BRgwL8` (`DHH Omarchy Quattro Announcement | TheStandup`):

- The video exposed no usable YouTube Most Replayed heatmap.
- Package-job state: `no_heatmap`.
- No media was acquired and no treatment run was created.

The immediate second live run reported:

```text
discovered: 0
analyzed: 0
packages ready/failed: 0/0
treatments rendered/failed: 0/0
```

This verifies idempotency through the final artifact stage.

The transcript selector has passed offline contract, integration, and installed-
package tests. The gated live smoke has intentionally not been run in this PR:
it requires separate operator authorization, a selected provider, and that
provider's credentials. It never touches the playlist, ledger, media, or
Remotion.

During the 2026-09-20 completion gate, `npx remotion compositions` found no
cached browser and downloaded Remotion's Chrome Headless Shell before listing
`AudiogramBasic`. That was a one-time Remotion tooling bootstrap side effect;
no selector provider, credential, playlist, ledger, or media operation ran.

Before the first schema migration, the legacy database was copied to:

```text
~/Library/Application Support/Audiogram Inbox/
  audiograms.pre-generic-2026-09-18.sqlite
```

## Commands

Run the complete pipeline:

```console
npm run youtube:inbox
```

Run automated tests and static checks:

```console
npm run test:youtube
npm run lint
```

Create dedicated credentials for the unofficial ChatGPT OAuth provider:

```console
npm run chatgpt:login
```

The selector smoke is inert unless explicitly authorized:

```console
npm run test:selector:live
# live smoke test not authorized
```

After separately authorizing a live request, select exactly one provider:

```console
AUDIOGRAM_RUN_LIVE_SELECTOR_SMOKE=1 \
AUDIOGRAM_LLM_PROVIDER=openai-api \
OPENAI_API_KEY=... \
npm run test:selector:live
```

Use `AUDIOGRAM_LLM_PROVIDER=chatgpt-oauth` after `npm run chatgpt:login` for
the unofficial provider. Do not run either form concurrently with login or a
transcript pipeline process before PR6 adds a cross-process lease.

List validated Remotion compositions:

```console
npx remotion compositions
```

Open Remotion Studio:

```console
npm run dev
```

## Configuration

| Variable                                    | Default                          | Purpose                                |
| ------------------------------------------- | -------------------------------- | -------------------------------------- |
| `AUDIOGRAM_GOOGLE_CLIENT_PATH`              | Application Support OAuth client | Google desktop OAuth client            |
| `AUDIOGRAM_GOOGLE_TOKEN_PATH`               | Application Support OAuth token  | Persisted refresh/access token         |
| `AUDIOGRAM_DB_PATH`                         | Application Support SQLite file  | Ledger location                        |
| `AUDIOGRAM_YOUTUBE_PLAYLIST`                | `Audiogram Inbox`                | Playlist title                         |
| `AUDIOGRAM_PACKAGE_VERSION`                 | `transcript-llm-v1`              | Package-selection/acquisition identity; heatmap uses `v1` |
| `AUDIOGRAM_TREATMENT_VERSION`               | none                             | Legacy fallback for package version    |
| `AUDIOGRAM_MAX_CLIPS`                       | `1`                              | Maximum heatmap peaks; heatmap only    |
| `AUDIOGRAM_MINIMUM_CLIP_SEPARATION_SECONDS` | `20`                             | Heatmap peak separation; heatmap only  |
| `AUDIOGRAM_CLIP_SELECTOR`                   | `transcript-llm`                 | `transcript-llm` or explicit heatmap   |
| `AUDIOGRAM_LLM_PROVIDER`                    | none                             | Required transcript provider           |
| `OPENAI_API_KEY`                            | none                             | Required only for `openai-api`         |
| `AUDIOGRAM_CHATGPT_AUTH_PATH`               | Application Support OAuth file   | Dedicated unofficial OAuth credentials |
| `AUDIOGRAM_TRANSCRIPT_CLIP_COUNT`           | `3`                              | Transcript clips, from 3 through 5     |
| `AUDIOGRAM_RUN_LIVE_SELECTOR_SMOKE`         | unset                            | Exact `1` authorizes one live smoke    |

Increment `AUDIOGRAM_PACKAGE_VERSION` only when package selection or generation
semantics intentionally change. Treatment versioning belongs to the registry
and is independent.

## Local state and prerequisites

OAuth material and SQLite remain outside Git:

```text
~/Library/Application Support/Audiogram Inbox/
├── google-oauth-client.json
├── google-oauth-token.json
├── chatgpt-oauth/
│   └── auth.json
└── audiograms.sqlite
```

The ChatGPT OAuth file is dedicated to this app and is never discovered from or
shared with Codex CLI state. Login calls the installed package's exported login
function, then validates and atomically promotes the result. The application
does not use the package proxy, CLI, or update check. The integration is
unofficial, and compatibility with future backend changes is not guaranteed.

Provider failure is terminal for that job and never switches to another
provider, so one provider's failure cannot incur another provider's quota or
billing. Credential serialization is currently in-process only; login, smoke,
and transcript pipeline commands must not overlap until PR6.

The executable pipeline requires Node.js 22, yt-dlp, FFmpeg/ffprobe, and the
project's locked npm dependencies. Node currently prints an experimental warning
for `node:sqlite`; the tests and live pipeline pass with Node `v22.23.2`.

The current locked dependency audit reports eight low-severity findings and no
moderate, high, or critical findings. The residual dependency and installed-
artifact provenance boundary is recorded in `docs/OPENAI_OAUTH_PROVENANCE.md`;
no automatic dependency upgrade was applied.

## Source map

- `scripts/youtube-pipeline.mjs`: complete executable pipeline.
- `scripts/audiogram-ledger.mjs`: explicit schema-version migration,
  validation, and state transitions.
- `scripts/youtube-inbox-pipeline-core.mjs`: playlist/heatmap orchestration.
- `scripts/clip-selector-smoke.mjs`: explicitly gated, synthetic one-request
  production selector contract check with safe summary output.
- `scripts/structured-generation-provider.mjs`: locked official API and
  unofficial ChatGPT OAuth provider transports.
- `scripts/transcript-selector.mjs`: prompt serialization and semantic clip
  derivation from grounded cue IDs.
- `scripts/clip-package-assets.mjs`: partial acquisition, caption alignment,
  whole-package validation, atomic publication, and crash-window reuse.
- `scripts/clip-processing-core.mjs`: idempotent package/treatment orchestration.
- `scripts/treatment-registry.mjs`: explicit treatment allowlist.
- `scripts/treatment-runner.mjs`: generic atomic Remotion renderer with
  package-versioned artifact paths.
- `src/Root.tsx`: dynamic metadata and `AudiogramBasic` registration.
- `src/Audiogram/Main.tsx`: package-driven V1 presentation.
- `scripts/*.test.mjs`: versioned migration, idempotency, failure isolation,
  staged acquisition/publication, recovery, registry, renderer, OAuth, heatmap,
  and pagination coverage.

## Deferred work

V2 adds local Whisper model weights as a caption fallback. V1 intentionally has
a YouTube-captions-only policy.

PR6 — recovery and concurrency:

- Cross-process pipeline/credential leasing and scheduled-run overlap
  prevention.
- Stale-running recovery, operator retry commands, and recovery drills.

PR7 — quality corpus:

- Curated real transcripts, human editorial scoring, prompt/model comparisons,
  regression thresholds, and false-positive analysis.

PR8 — operations:

- CI matrix, database backup/restore, artifact retention, scheduler deployment,
  alerts, cost/quota reporting, and soak testing.

Also deferred outside those PRs:

- Additional treatments and any treatment-selection UI.
- A manual single-URL ingestion command.
- A fallback selection policy for videos without a YouTube heatmap.
- Daily scheduling and remote durable execution.

When several independent treatments are added, subagent-driven development may
be appropriate. The single-treatment V1 was implemented inline with one final
independent review.
