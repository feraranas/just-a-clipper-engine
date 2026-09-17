# Partial Download and Audiogram Rendering Design

Date: 2026-09-16

Status: Approved in chat; awaiting written-spec review

## Purpose

Extend Audiogram Inbox from heatmap selection through one complete, durable
Remotion artifact without downloading the full source video.

V1 optimizes for the shortest reliable path to a working MVP. It uses YouTube
captions only. Local Whisper transcription and locally cached model weights are
explicitly deferred to V2.

## Scope

V1 will process the existing rank-1 heatmap selection for each pending video.
The design remains compatible with multiple ranked clips, but V1 will request
and render one clip per processing job by default.

V1 includes:

- Partial, audio-only acquisition for the selected interval.
- Creator-provided English captions with automatic English captions as fallback.
- Caption trimming and timestamp rebasing for the selected interval.
- YouTube thumbnail acquisition.
- Dynamic Remotion props for title, thumbnail, audio, and captions.
- MP4 rendering to a deterministic artifact path.
- SQLite asset paths and processing state transitions.
- Idempotent reruns that do not reacquire or rerender completed clips.

V1 excludes:

- Full-video downloads.
- Local speech-to-text.
- Caption translation.
- Automatic retries for failed clips.
- More than one rendered clip per video by default.
- Remote scheduling or deployment.

## Approaches considered

### YouTube SRT captions

This is the selected V1 approach. Remotion's existing caption loader already
uses `parseSrt()` from `@remotion/captions`, so SRT requires no custom subtitle
format parser. Caption units may be phrases rather than individual words, but
the result is sufficient for the first complete artifact.

### YouTube JSON3 captions

JSON3 can preserve finer timing information, but it requires a custom parser and
additional validation across creator and automatic caption variants. This is not
required to prove the end-to-end MVP.

### Local Whisper transcription

Whisper avoids dependence on YouTube captions and can produce token-level
timings, but it introduces model installation, model storage, transcription
latency, language configuration, and additional failure modes. It is deferred to
V2 and will operate only on the already downloaded partial audio.

## End-to-end V1 flow

```text
SQLite clip in selected state
        |
        v
Partial audio-only yt-dlp acquisition
        |
        +--> validate resulting duration
        |
        v
Creator English SRT
        |
        +--> if unavailable: automatic English SRT
        |
        +--> if unavailable: record exact failure and stop
        |
        v
Trim and rebase captions to clip-local time
        |
        v
Acquire thumbnail
        |
        v
Mark clip media_ready with relative asset paths
        |
        v
Render Remotion Audiogram with clip-specific props
        |
        v
Validate MP4 exists and is non-empty
        |
        v
Mark clip rendered and store artifact_relative_path
        |
        v
Mark job rendered when all required clips are rendered
```

## Filesystem layout

Generated source assets will live under Remotion's `public/` directory so
`staticFile()` can serve them during Studio preview and rendering:

```text
public/generated/<video-id>/<treatment-version>/clip-<rank>/
├── audio.wav
├── captions.source.srt
├── captions.json
├── thumbnail.jpg
└── render-props.json
```

Rendered artifacts will live under:

```text
out/audiograms/<video-id>/<treatment-version>/clip-<rank>.mp4
```

Both locations are deterministic. The generated working directory will be
ignored by Git, and `out/` is already ignored. Paths persisted to SQLite will be
project-relative so a project checkout can be moved without rewriting the
ledger.

Partial audio, captions, and thumbnail inputs will remain after rendering. They
are small compared with the full source and make rerendering reproducible without
another network request.

## Partial media acquisition

The acquisition command will invoke yt-dlp as a child process with an argument
array rather than a shell command string.

Required behavior:

- `--no-playlist` limits work to one video.
- `--download-sections` receives the exact selected start and end timestamps.
- `--extract-audio` selects an audio stream rather than video.
- `--audio-format wav` creates a stable Remotion and waveform input.
- A deterministic output template targets the clip working directory.
- There is no retry path that omits `--download-sections`.

After acquisition, FFprobe will measure the output duration. The file must be
non-empty and its duration must be within a small technical tolerance of the
selected interval. A result resembling the full source duration is rejected,
the clip is marked failed, and rendering does not start.

## Caption policy

Caption acquisition is independent of media acquisition and uses yt-dlp's
subtitle-only behavior.

The order is:

1. Request creator-provided English SRT with media download disabled.
2. If no creator SRT was produced, request automatic English SRT with media
   download disabled.
3. If neither exists, record an exact caption-unavailable failure and stop that
   clip.

The selected SRT contains source-video timestamps. Caption processing will:

1. Parse SRT through `@remotion/captions`.
2. Keep entries that overlap the selected source interval.
3. Clamp entries that cross the interval boundaries.
4. Subtract the selected start timestamp from every retained timestamp.
5. Write Remotion `Caption[]` JSON beginning at clip-local time zero.
6. Record caption provenance as `youtube_creator` or `youtube_auto`.

No captionless render is produced in V1.

## Thumbnail policy

The pipeline will acquire one YouTube thumbnail without downloading video. It
will normalize the result to `thumbnail.jpg` in the clip working directory.
Thumbnail failure is a clip failure because the current audiogram layout requires
a cover image.

## Remotion changes

The existing `Audiogram` composition remains 1080 by 1080 and retains the
current gray waveform with advancing white progress.

The composition schema will add clip-specific fields:

- `title`
- `audioFileName`
- `captionsFileName`
- `coverImageFileName`

These values are paths relative to `public/`. `Root.tsx` will convert them with
`staticFile()` before calculating audio duration, fetching captions, or rendering
media.

`calculateMetadata` will continue to derive duration from the actual partial
audio. It will also load the clip-local captions and set a deterministic default
output name, although the pipeline will still pass an explicit output path.

`Audiogram/Main.tsx` will render the supplied title and cover image rather than
the template's hard-coded title and cover.

The render command will pass a JSON props file:

```console
npx remotion render Audiogram <artifact-path> --props=<render-props-path>
```

## SQLite changes

The existing database must migrate in place without deleting or recreating the
validated heatmap record.

The `clips` table will gain nullable fields for:

- `media_relative_path`
- `captions_relative_path`
- `thumbnail_relative_path`
- `caption_source`
- `last_error`

The existing `artifact_relative_path` remains the rendered-output pointer.

The ledger initialization will inspect `PRAGMA table_info(clips)` and add missing
columns through idempotent migrations. A new database will receive the complete
schema directly.

Clip state transitions are:

```text
selected -> media_ready -> rendered
       \-> failed
media_ready ---------> failed
```

The processing job remains `heatmap_ready` while required clips are selected or
media-ready. It changes to `rendered` only after all required V1 clips are
rendered. A clip failure records the error and changes the job to `failed`.

## Idempotency and recovery

- `selected` clips are eligible for acquisition.
- `media_ready` clips skip network acquisition and resume at rendering.
- `rendered` clips are never downloaded or rendered again.
- Existing deterministic asset files are accepted only when their ledger state
  and validation checks agree.
- A failed stage records its exact error and does not silently retry during the
  next scheduled run.
- Intentional reprocessing uses a new treatment version, preserving prior jobs
  and artifacts.

V1 does not add a failed-job reset command. A controlled retry command can be
added after observing real failure modes.

## Error handling

Each external process will capture its command name, exit status, and bounded
stderr. Secrets and OAuth token contents must never be logged.

Failures are stage-specific:

- Partial download failure: no render attempt.
- Duration validation failure: no render attempt and no full-download fallback.
- Missing captions: no captionless render.
- Thumbnail failure: no render attempt.
- Remotion render failure: retain validated partial inputs, mark failed, and do
  not set an artifact path.
- Artifact validation failure: mark failed even if Remotion exited successfully.

The pipeline continues to the next independent clip after recording a failure,
but exits non-zero if any clip failed.

## Testing strategy

### Unit tests

- yt-dlp audio arguments always contain the selected time range, audio-only
  extraction, and deterministic output template.
- There is no code path that removes the section restriction.
- Creator captions are preferred over automatic captions.
- Automatic captions are used only when creator captions are absent.
- Caption filtering, boundary clamping, and timestamp rebasing are correct.
- Duration validation accepts the intended clip and rejects full-length output.
- Render props contain only public-relative paths and the persisted video title.

### Ledger tests

- Existing databases migrate without losing videos, jobs, heatmaps, or clips.
- `selected -> media_ready -> rendered` persists the expected paths.
- A rendered clip is absent from pending acquisition and render queries.
- A media-ready clip resumes at render without acquisition.
- Multiple clip ranks remain independent.

### Integration tests

- Injected process runners verify orchestration without network or rendering.
- A fake partial asset and captions file produce the expected props and state
  transitions.
- A simulated command failure persists a bounded error and prevents later
  stages.

### Live MVP verification

For YouTube video `KHd-luu3M8s` and rank-1 interval `882.2` to `902.25` seconds:

- The acquired audio duration matches approximately 20.05 seconds.
- No complete `.mp4`, `.webm`, `.m4a`, or source-duration audio is stored.
- Creator-provided English captions are selected.
- The rendered square MP4 exists and is non-empty.
- A representative rendered frame shows the real title, thumbnail, captions,
  and gray/white waveform treatment.
- The ledger contains relative input and artifact paths.
- A second pipeline run performs no acquisition or rendering.

## V2: local Whisper fallback

V2 will introduce local Whisper only after the V1 artifact and idempotent rerun
are proven.

Caption precedence becomes:

```text
YouTube creator captions
        |
        v
YouTube automatic captions
        |
        v
Local Whisper on partial audio
```

Whisper requirements:

- Transcribe only the selected partial audio, never a full source download.
- Store Whisper binaries and reusable model weights outside Git:

  ```text
  ~/Library/Application Support/Audiogram Inbox/models/whisper/
  ```

- Cache model weights across videos and scheduled runs.
- Make model and language configurable.
- Default to a smaller model chosen for recurring local throughput; changing the
  model is a treatment change that can justify a new treatment version.
- Produce token-level Remotion `Caption[]` JSON.
- Persist caption provenance, Whisper implementation version, model name,
  language, and transcription error.
- Do not redownload audio that already passed partial-duration validation.
- Add focused tests for model-path resolution, cached-weight reuse, caption
  conversion, and fallback ordering.

V2 may later evaluate YouTube JSON3 parsing for better timing before invoking
Whisper, but JSON3 support is not required for the Whisper fallback milestone.

## Acceptance criteria

V1 is complete only when all of the following are true:

1. The existing validated heatmap clip renders as a playable audiogram MP4.
2. Only the selected audio interval is acquired.
3. The artifact displays the real title, YouTube thumbnail, and clip-local
   captions.
4. The gray waveform and advancing white progress effect remain intact.
5. SQLite records media, caption, thumbnail, and artifact paths.
6. The clip and job reach `rendered` only after artifact validation.
7. Automated tests, lint, TypeScript, and the Remotion render pass.
8. A second live run performs no repeated acquisition or rendering.
9. The project status handoff is updated to describe the completed stage and V2
   Whisper fallback.
