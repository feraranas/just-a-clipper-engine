# Audiogram Inbox: Project Status and Handoff

Last updated: 2026-09-19

This is the shared handoff for humans and coding agents. Update it whenever a
durable pipeline stage or its operational behavior changes.

## Outcome

The V1 MVP is implemented and verified end to end. Videos added to the private
YouTube playlist `Audiogram Inbox` are imported, analyzed for YouTube Most
Replayed peaks, packaged without a full-video download, and rendered through an
explicit Remotion treatment.

V1 exposes one treatment: `audiogram-basic@1`.

```text
YouTube playlist
      |
      v
OAuth importer -> SQLite package job -> yt-dlp heatmap metadata
                                           |
                                           v
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
- Transactional migration from the legacy treatment-scoped ledger.
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
- Temporary render output, non-empty validation, and atomic publication.
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

## Deterministic paths

Generated package assets are runtime files ignored by Git:

```text
public/generated/<video-id>/<package-version>/clip-<rank>/
├── audio.wav
├── captions.json
├── thumbnail.jpg
└── package.json
```

Treatment output is also ignored by Git:

```text
out/treatments/<treatment-id>/<treatment-version>/<video-id>/
├── clip-<rank>.props.json
└── clip-<rank>.mp4
```

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
| `AUDIOGRAM_PACKAGE_VERSION`                 | `v1`                             | Package-selection/acquisition identity |
| `AUDIOGRAM_TREATMENT_VERSION`               | none                             | Legacy fallback for package version    |
| `AUDIOGRAM_MAX_CLIPS`                       | `1`                              | Maximum independent peaks per video    |
| `AUDIOGRAM_MINIMUM_CLIP_SEPARATION_SECONDS` | `20`                             | Separation between selected peaks      |

Increment `AUDIOGRAM_PACKAGE_VERSION` only when package selection or generation
semantics intentionally change. Treatment versioning belongs to the registry
and is independent.

## Local state and prerequisites

OAuth material and SQLite remain outside Git:

```text
~/Library/Application Support/Audiogram Inbox/
├── google-oauth-client.json
├── google-oauth-token.json
└── audiograms.sqlite
```

The executable pipeline requires Node.js 22, yt-dlp, FFmpeg/ffprobe, and the
project's locked npm dependencies. Node currently prints an experimental warning
for `node:sqlite`; the tests and live pipeline pass with Node `v22.23.2`.

## Source map

- `scripts/youtube-pipeline.mjs`: complete executable pipeline.
- `scripts/audiogram-ledger.mjs`: schema, migration, and state transitions.
- `scripts/youtube-inbox-pipeline-core.mjs`: playlist/heatmap orchestration.
- `scripts/clip-package-assets.mjs`: partial acquisition and caption alignment.
- `scripts/clip-processing-core.mjs`: idempotent package/treatment orchestration.
- `scripts/treatment-registry.mjs`: explicit treatment allowlist.
- `scripts/treatment-runner.mjs`: generic atomic Remotion renderer.
- `src/Root.tsx`: dynamic metadata and `AudiogramBasic` registration.
- `src/Audiogram/Main.tsx`: package-driven V1 presentation.
- `scripts/*.test.mjs`: migration, idempotency, failure isolation, acquisition,
  registry, renderer, OAuth, heatmap, and pagination coverage.

## Deferred work

V2 adds local Whisper model weights as a caption fallback. V1 intentionally has
a YouTube-captions-only policy.

Also deferred:

- Additional treatments and any treatment-selection UI.
- A manual single-URL ingestion command.
- Retry/recovery commands for terminal failures.
- A fallback selection policy for videos without a YouTube heatmap.
- Daily scheduling and remote durable execution.

When several independent treatments are added, subagent-driven development may
be appropriate. The single-treatment V1 was implemented inline with one final
independent review.
