# Generic Clip Packages and Treatment Registry Design

Date: 2026-09-18

Status: Implemented and live-verified in PR #3 (`#2` is a GitHub issue)

## Purpose

Generalize Audiogram Inbox into a clip-processing pipeline that can apply
multiple Remotion treatments without tying discovery, media acquisition, or
persistence to the original Audiogram template.

V1 still produces only the existing audiogram treatment. The architectural
change establishes reusable clip packages and an explicit treatment registry so
future treatments can be added independently.

This specification supersedes the architecture in
`2026-09-16-partial-download-audiogram-design.md`. Its partial-download,
YouTube-caption, and no-full-video constraints remain requirements of this
design.

## Success criteria

- A selected interval and its acquired assets exist independently of any
  Remotion treatment.
- The same package can be rendered by multiple treatments without reacquiring
  assets already present in the package.
- Treatment identity and version are distinct from package-generation version.
- Adding a treatment that uses supported asset roles does not require modifying
  the generic acquisition or rendering pipeline.
- V1 exposes only `audiogram-basic@1`.
- Existing SQLite video, heatmap, and selected-clip data survive migration.
- Repeated runs remain duplicate-safe.

## V1 scope

V1 includes:

- Treatment-independent `ClipPackage` records.
- Named reusable package assets.
- An explicit, code-owned treatment registry.
- A generic treatment runner.
- `audiogram-basic@1` as the only registered treatment.
- Partial audio, YouTube captions, and thumbnail assets.
- Multiple ranked packages in the schema, with rank 1 processed by default.
- Deterministic project-relative asset and artifact paths.
- Transactional migration from the current ledger.

V1 excludes:

- Additional treatments.
- Dynamic plugin discovery or loading third-party treatment modules.
- A treatment-selection UI.
- Local Whisper transcription or model weights; these remain V2 work.
- Caption translation.
- Full-video downloads.
- Automatic retry of terminal failures.
- Remote scheduling or cloud execution.

## Approaches considered

### Shared package model

Selected. Packages, assets, and treatment runs are separate persisted concepts.
This adds a deliberate schema migration now, but it prevents repeated media
acquisition and gives future treatments a clean interface.

### Adapter over the current ledger

Rejected. Wrapping current treatment-scoped processing jobs as runtime packages
would reduce initial migration work, but package selection and treatment
identity would remain coupled and require another redesign when a second
treatment is added.

### Dynamic plugin system

Rejected for V1. Runtime module discovery would require compatibility checks,
configuration validation, loading rules, and a larger security boundary without
helping the single-treatment MVP.

## Domain model

```text
YouTube video
    |
    v
Package job -- heatmap analysis and interval selection
    |
    +-- ClipPackage rank 1
    +-- ClipPackage rank 2 ... later
            |
            +-- audio asset
            +-- captions asset
            +-- thumbnail asset
                    |
                    v
         TreatmentRun: audiogram-basic@1
                    |
                    v
               Remotion MP4
```

### Package job

A package job owns versioned source analysis for one video. Its version changes
when peak selection or package-building semantics change. It is not a treatment
version.

Package-job states are:

```text
discovered -> heatmap_ready
          \-> no_heatmap
          \-> failed
```

`heatmap_ready` means the normalized heatmap was saved and at least one package
interval was selected. Package acquisition has its own state.

### ClipPackage

A `ClipPackage` represents one selected interval and the assets currently
available for it. It is media-agnostic: no field assumes a particular Remotion
composition.

Its runtime shape contains:

```ts
type ClipPackage = {
  id: number;
  packageVersion: string;
  source: {
    videoId: string;
    title: string;
    sourceUrl: string;
  };
  interval: {
    rank: number;
    startSeconds: number;
    endSeconds: number;
    score: number;
  };
  status: "selected" | "ready" | "failed";
  assets: Record<string, ClipAsset>;
};
```

Asset roles are open strings validated by treatment definitions. V1 produces
`audio`, `captions`, and `thumbnail`. Future treatments may request roles such
as `video` without changing the package table. A new role requires a focused
asset provider, but not a ledger or generic-renderer redesign.

Package assets are additive and are not overwritten in place by unrelated
treatments. A treatment can reuse every matching validated asset and request
only missing roles.

### Treatment definition

Treatments are an explicit code allowlist rather than dynamically loaded
plugins:

```ts
type TreatmentDefinition = {
  id: string;
  version: string;
  compositionId: string;
  requiredAssets: readonly string[];
  buildInputProps: (clipPackage: ClipPackage) => Record<string, unknown>;
  output: {
    extension: "mp4";
    codec: "h264";
  };
};
```

The registry must reject duplicate `(id, version)` identities. Unknown
treatments are errors; the pipeline never guesses a composition or silently
falls back to another treatment.

V1 contains exactly one definition:

```text
audiogram-basic@1
|- composition: AudiogramBasic
|- required assets: audio, captions, thumbnail
`- output: H.264 MP4
```

The Remotion root may register multiple compositions normally. The treatment
registry controls which registered composition the automated pipeline may
invoke. Composition dimensions and dynamic duration remain owned by Remotion,
not duplicated in the treatment registry.

### Treatment run

A treatment run joins a reusable package to one treatment identity and version.
Its states are:

```text
pending -> rendered
       \-> failed
```

A render failure affects only that run. It cannot invalidate or delete its
package or package assets.

## SQLite model

### `videos`

Retains the current canonical YouTube metadata and first/last-seen timestamps.

### `package_jobs`

Stores:

- `id`
- `video_id`
- `package_version`
- `status`
- `heatmap_json`
- `last_error`
- creation and update timestamps

`(video_id, package_version)` is unique.

### `clip_packages`

Stores:

- `id`
- `package_job_id`
- `rank`
- interval start and end seconds
- heatmap score
- package status and last error
- creation and update timestamps

`(package_job_id, rank)` is unique, preserving multi-clip support.

### `clip_assets`

Stores:

- `id`
- `clip_package_id`
- asset role
- project-relative path
- provenance, such as `youtube_creator`, `youtube_auto`, or `yt_dlp`
- optional JSON metadata
- creation timestamp

`(clip_package_id, role)` is unique in V1.

### `treatment_runs`

Stores:

- `id`
- `clip_package_id`
- `treatment_id`
- `treatment_version`
- status
- project-relative artifact path
- last error
- creation and update timestamps

`(clip_package_id, treatment_id, treatment_version)` is unique.

## Migration

The migration runs in one SQLite transaction and never recreates the database
file from scratch.

1. Create the generic tables with their complete constraints.
2. Copy each existing `processing_jobs` row to `package_jobs`, mapping the old
   `treatment_version` value to `package_version`. Map `discovered`,
   `heatmap_ready`, `no_heatmap`, and `failed` directly; map legacy `rendered`
   to `heatmap_ready` because rendering is now tracked separately.
3. Copy each existing `clips` row to `clip_packages` while preserving interval,
   rank, score, timestamps, and relationships. Map `selected` and `failed`
   directly; map legacy `media_ready` and `rendered` to package `ready`.
4. If a legacy clip already has an artifact path, preserve it as an
   `audiogram-basic@1` treatment run.
5. Validate source and destination row counts and required relationships.
6. Only after validation, replace the legacy tables.

The current selected heatmap clip must remain queryable after migration. Tests
will exercise both an empty database and a pre-migration database populated with
existing records.

## Filesystem layout

Reusable inputs are package-versioned, not treatment-versioned:

```text
public/generated/<video-id>/<package-version>/clip-<rank>/
|- audio.wav
|- captions.source.srt
|- captions.json
|- thumbnail.jpg
`- package.json
```

Treatment artifacts are isolated by treatment identity and version:

```text
out/treatments/<treatment-id>/<treatment-version>/<video-id>/clip-<rank>.mp4
```

Only project-relative paths are persisted. Generated inputs and rendered
artifacts remain ignored by Git.

## End-to-end V1 flow

1. Sync the YouTube playlist and upsert videos and package jobs.
2. Analyze only `discovered` package jobs with yt-dlp metadata mode.
3. Persist the heatmap and one or more selected package intervals.
4. For each selected package, acquire only its time range as audio.
5. Acquire creator English captions, falling back to automatic English captions.
6. Trim, clamp, and rebase captions to package-local time.
7. Acquire the thumbnail and validate every produced asset.
8. Persist asset rows and mark the package ready only after validation succeeds.
9. Create the duplicate-safe `audiogram-basic@1` treatment run.
10. Validate required assets and build composition props from the package.
11. Render to a temporary artifact, validate it, and atomically promote it to
    the deterministic final path.
12. Mark only the treatment run rendered and save its artifact path.

Repeated runs skip ready acquisition work and rendered treatment runs.

## Remotion integration

The existing composition becomes `AudiogramBasic`. It keeps the current 1080 by
1080 layout, 32-sample gray waveform, and advancing white progress effect.

The composition accepts dynamic title, audio, captions, and thumbnail props.
Public-relative package paths are resolved with `staticFile()`. Remotion
`calculateMetadata` derives the duration from the actual partial audio and may
transform validated input props before render.

The generic treatment runner passes the selected registry entry's
`compositionId` and generated JSON props to Remotion. It does not import or
branch on the Audiogram React component.

## Failure and recovery rules

- A package acquisition error marks that package failed and records bounded
  stderr without credentials or token contents.
- A treatment validation or render error marks only that treatment run failed.
- `no_heatmap`, package `failed`, and treatment-run `failed` are terminal for
  automatic V1 runs.
- V1 does not add a failed-record reset command.
- A process crash before a terminal database transition leaves work pending and
  safely rerunnable.
- Temporary artifacts are never treated as completed output.
- Media acquisition never retries without `--download-sections` and
  `--extract-audio`; full-video fallback is forbidden.
- Missing required assets stop rendering before Remotion is invoked.

## Verification strategy

Implementation is inline and test-first. Each behavior begins with a failing
test, followed by the minimum implementation needed to pass it.

Required coverage includes:

- Transactional migration preserves existing video, heatmap, and clip records.
- More than one ranked package can belong to a package job.
- Assets are reusable across separate treatment runs.
- Registry construction rejects duplicate identities.
- Looking up an unknown treatment fails explicitly.
- Missing required assets prevent render invocation.
- Treatment props are built from the generic package contract.
- Render failure leaves the package ready and reusable.
- Successful reruns neither reacquire assets nor rerender artifacts.
- `audiogram-basic@1` maps audio, captions, thumbnail, and title correctly.
- Remotion lists the `AudiogramBasic` composition.
- Existing playlist, OAuth helper, heatmap, and idempotency tests continue to
  pass.

The implementation PR requires one independent final review after all automated
checks pass. Subagent-driven implementation is deferred until multiple
genuinely independent treatments are being added.

## Delivery sequence

1. This design is delivered in a documentation-only PR.
2. After written-spec approval, create a detailed implementation plan.
3. Implement the plan inline using test-driven development in a separate PR.
4. Run one independent final review before merging the implementation PR.
5. Add each future treatment through its own focused PR.
