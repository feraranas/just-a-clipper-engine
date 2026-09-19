# Audiogram Inbox: Project Status and Handoff

Last updated: 2026-09-18

This is the shared project handoff for humans and coding agents. It records what
has been implemented, what has been verified, the important design decisions,
and the next safe increment. Update it whenever the pipeline gains a durable
stage or its operational behavior changes.

## Goal

Turn videos added to a private YouTube playlist named `Audiogram Inbox` into
reusable clip packages based on YouTube's Most Replayed heatmap, then apply
explicitly registered Remotion treatments. V1 has one treatment:
`audiogram-basic@1`.

The current architecture specification is
`docs/superpowers/specs/2026-09-18-clip-package-treatment-registry-design.md`.
The older partial-audiogram implementation plan is superseded and must not be
executed.

The intended pipeline is:

```text
Private YouTube playlist
        |
        v
OAuth playlist importer
        |
        v
SQLite package ledger     <---- prevents duplicate acquisition
        |
        v
yt-dlp metadata only       <---- no media download at this stage
        |
        v
Reusable ClipPackages
        |
        v
Selected-range download    <---- next stage; not implemented yet
        |
        v
Treatment registry         <---- audiogram-basic@1 in V1
        |
        v
Remotion render            <---- next stage; not implemented yet
        |
        v
Artifact path saved in SQLite
```

## Current status

The pipeline currently ends after heatmap selection. It can:

- Authenticate to YouTube with Google OAuth using read-only access.
- Find the private `Audiogram Inbox` playlist.
- Import every video in that playlist with pagination.
- Upsert imported videos into a persistent SQLite ledger.
- Create one processing job per `(YouTube video, treatment version)`.
- Call yt-dlp in metadata-only mode and read the YouTube heatmap without
  downloading video or audio.
- Select the strongest independent heatmap peak.
- Persist the complete normalized heatmap and selected clip timestamps.
- Skip videos whose current treatment job has already been analyzed.
- Store multiple ranked clips per processing job when that behavior is enabled.

The Remotion presentation has also been adjusted:

- The waveform uses fewer samples, so it displays fewer visual waves.
- The waveform has a gray base with a white progress layer advancing over it.

## Verified example

The live playlist currently contains:

- Title: `Your phone addiction is keeping you from achieving flow state | Arthur Brooks`
- YouTube video ID: `KHd-luu3M8s`
- Processing status: `heatmap_ready`
- Selected clip: `882.2` to `902.25` seconds, or approximately
  `14:42.2` to `15:02.25`
- Heatmap score: `1.0`
- Artifact path: not set because partial download and rendering are not built yet

The first run discovered and analyzed this video. A subsequent live run returned
`discovered: 0`, `existing: 1`, and an empty `analyzed` array. This verifies that
the persisted ledger prevents the same treatment job from being analyzed again.

## Commands

Run the complete pipeline through its currently implemented heatmap stage:

```console
npm run youtube:inbox
```

Run only the original playlist discovery command, without the ledger or heatmap
processing:

```console
npm run youtube:discover
```

Run the importer and ledger tests:

```console
npm run test:youtube
```

Run lint and TypeScript validation:

```console
npm run lint
```

Open Remotion Studio:

```console
npm run dev
```

## Persistent local state

OAuth credentials and the SQLite database intentionally live outside the Git
repository:

```text
~/Library/Application Support/Audiogram Inbox/
├── google-oauth-client.json
├── google-oauth-token.json
└── audiograms.sqlite
```

The OAuth token and client configuration must not be committed. The database is
also local runtime state, not source code. A future remote runner must provide
secure replacements for credential storage and durable database storage.

## SQLite data model

The ledger uses three tables.

### `videos`

One row per YouTube video ID. It stores the current title, canonical source URL,
playlist ID, and first/last-seen timestamps. Re-importing a playlist item updates
its metadata instead of creating another row.

### `processing_jobs`

One row per `(video_id, treatment_version)`. The unique constraint is the main
processing footprint: the same video and treatment version cannot create a
duplicate job, while a later treatment version can intentionally process the
source again.

Current statuses are:

- `discovered`: waiting for heatmap extraction.
- `heatmap_ready`: heatmap stored and at least one clip selected.
- `no_heatmap`: yt-dlp returned no usable heatmap; treated as terminal for the
  automatic daily run.
- `failed`: processing failed and the error is stored.
- `rendered`: reserved for the completed rendering stage.

### `clips`

One or more ranked selections belonging to a processing job. Each row stores:

- Rank.
- Start and end timestamps in seconds.
- Heatmap score.
- Clip status.
- Project-relative Remotion artifact path.

V1 requests one selected clip, but this table already supports multiple clips
without changing the video or job identity model.

## Idempotency rules

1. `videos.video_id` is unique.
2. `(processing_jobs.video_id, processing_jobs.treatment_version)` is unique.
3. `(clips.processing_job_id, clips.rank)` is unique.
4. Normal playlist sync updates titles and last-seen timestamps but preserves
   completed job status and clip rows.
5. The automatic heatmap stage only processes jobs in `discovered` status.
6. `no_heatmap`, `failed`, and completed jobs are not retried automatically.
7. To intentionally reprocess videos after changing the treatment, use a new
   `AUDIOGRAM_TREATMENT_VERSION` rather than deleting history.

## Configuration

The pipeline recognizes these environment variables:

| Variable                                    | Default                               | Purpose                                                            |
| ------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| `AUDIOGRAM_GOOGLE_CLIENT_PATH`              | Application Support OAuth client file | Google desktop OAuth client configuration                          |
| `AUDIOGRAM_GOOGLE_TOKEN_PATH`               | Application Support OAuth token file  | Persisted Google refresh/access token                              |
| `AUDIOGRAM_DB_PATH`                         | Application Support SQLite file       | Override the ledger location, especially for CI or a remote runner |
| `AUDIOGRAM_YOUTUBE_PLAYLIST`                | `Audiogram Inbox`                     | Playlist title to import                                           |
| `AUDIOGRAM_TREATMENT_VERSION`               | `v1`                                  | Versioned identity for intentional reprocessing                    |
| `AUDIOGRAM_MAX_CLIPS`                       | `1`                                   | Maximum independent peaks selected per video                       |
| `AUDIOGRAM_MINIMUM_CLIP_SEPARATION_SECONDS` | `20`                                  | Minimum time separating selected peaks                             |

## Source map

- `scripts/youtube-pipeline.mjs`: executable OAuth, playlist, ledger, and heatmap
  pipeline.
- `scripts/youtube-inbox.mjs`: original discovery-only importer.
- `scripts/youtube-auth-core.mjs`: OAuth configuration and playlist lookup
  helpers.
- `scripts/youtube-playlist-core.mjs`: paginated playlist-item collection.
- `scripts/audiogram-ledger.mjs`: schema, migrations-by-creation, idempotent
  upserts, job state, and clip persistence.
- `scripts/youtube-heatmap-core.mjs`: metadata-only yt-dlp invocation,
  normalization, and independent-peak selection.
- `scripts/youtube-inbox-pipeline-core.mjs`: orchestration between importer,
  ledger, and heatmap selection.
- `scripts/*.test.mjs`: unit and integration coverage for OAuth helpers,
  pagination, SQLite idempotency, multiple clips, heatmap selection, terminal
  no-heatmap handling, and duplicate-free reruns.
- `src/Audiogram/Oscilloscope.tsx`: gray waveform and advancing white progress
  effect.
- `src/Root.tsx`: waveform configuration, including the lower sample count.

## Verification baseline

At this checkpoint:

- `npm run test:youtube`: 12 tests passed, 0 failed.
- `npm run lint`: ESLint and TypeScript completed successfully.
- Live playlist run: succeeded and persisted the selected heatmap clip.
- Live idempotency rerun: performed no second heatmap analysis.
- Repository media check: no `.mp4`, `.webm`, `.m4a`, or `.mp3` was created by
  the metadata-only stage.

Node.js 22 currently prints an experimental-feature warning for its built-in
`node:sqlite` module. The current implementation and tests pass despite that
warning. Treat a Node runtime upgrade as a separate, tested change.

## Not implemented yet

- Downloading only the selected media interval.
- Feeding that interval and its metadata into the Remotion composition.
- Generating or importing captions for the selected interval.
- Rendering the final Remotion artifact.
- Updating `clips.status` and `artifact_relative_path` after a successful render.
- A manual single-URL ingestion command. Links can still be explored manually,
  but they do not yet enter the ledger through a dedicated command.
- Automatic daily scheduling.
- Automatic retries or a recovery command for `failed` jobs.
- A policy for videos that do not expose a YouTube heatmap.

## Next implementation slice

Build one end-to-end artifact for the existing selected clip without downloading
the entire source video:

1. Read the rank-1 selected interval from SQLite.
2. Use yt-dlp's time-range support (`--download-sections`) with FFmpeg to acquire
   only the interval required by the composition.
3. Store the media under a deterministic, project-relative working path.
4. Generate or align captions for that interval.
5. Pass the clip-specific media, timing, title, and captions into Remotion.
6. Render the artifact to a deterministic output path.
7. Only after a successful render, set the clip to `rendered`, save
   `artifact_relative_path`, and mark the processing job `rendered` when its
   required clips are complete.
8. Rerun the command and verify that neither the media nor the artifact is
   produced twice.

Important constraint: the default workflow must not download a full YouTube
video merely to render a short excerpt. If a source or format prevents reliable
range acquisition, record the exact failure and stop instead of silently falling
back to a full download.

## Deferred scheduling decision

Prove the complete pipeline manually before scheduling it. For always-on
execution:

1. Use a ChatGPT Work scheduled task only if it can invoke a connected remote
   service that owns the executable pipeline and persistent state.
2. Otherwise prefer GitHub Actions with `openai/codex-action`.
3. Keep a small scheduled VM or container as a fallback if GitHub Actions is not
   suitable for yt-dlp, FFmpeg, and Remotion.

A remote runner must provide secure Google OAuth token storage, yt-dlp and
FFmpeg, Node/Remotion dependencies, durable database storage, and durable output
artifact storage. Do not pursue a Grok-based alternative for this project.
