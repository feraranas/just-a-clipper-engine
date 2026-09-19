# Partial Download and Audiogram Implementation Plan

> **Superseded:** Do not execute this plan. The generic package and treatment
> architecture in
> `docs/superpowers/specs/2026-09-18-clip-package-treatment-registry-design.md`
> replaces its Audiogram-specific structure. A new implementation plan will be
> written after that specification receives written review approval.

**Goal:** Turn each selected YouTube heatmap clip into one duplicate-safe Remotion MP4 using only partial audio, YouTube captions, and a thumbnail.

**Architecture:** Extend the SQLite ledger with resumable clip asset states, then add focused Node modules for YouTube captions, partial audio and thumbnail acquisition, and Remotion rendering. The existing `youtube:inbox` command will orchestrate each stage in sequence and persist project-relative paths after validation.

**Tech Stack:** Node.js 22 ESM, built-in `node:sqlite`, yt-dlp 2026.08.19, FFmpeg/FFprobe 8.1, Remotion 4.0.525, React 19, `@remotion/captions`, Mediabunny, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-16-partial-download-audiogram-design.md`

## Global Constraints

- V1 uses creator-provided English captions, then automatic English captions; it never invokes Whisper.
- Never run an audio acquisition command without `--download-sections` and `--extract-audio`.
- Never fall back to downloading a complete source video.
- Use one rank-1 clip per video by default while preserving multi-clip schema support.
- Store generated inputs under `public/generated/<video-id>/<treatment-version>/clip-<rank>/`.
- Store rendered artifacts under `out/audiograms/<video-id>/<treatment-version>/clip-<rank>.mp4`.
- Persist only project-relative paths in SQLite.
- Do not commit OAuth credentials, tokens, generated media, model weights, or rendered artifacts.
- Preserve the current 1080 by 1080 layout, 32-sample gray waveform, and advancing white progress effect.
- A failed clip records the exact bounded error and is not retried automatically.
- Run tests before and after each implementation step; commit only the files named by the task.

---

## File structure

### New files

- `scripts/youtube-captions-core.mjs`: acquire creator/automatic SRT captions and convert them to clip-local Remotion captions.
- `scripts/youtube-captions-core.test.mjs`: fallback ordering and caption timestamp tests.
- `scripts/youtube-media-core.mjs`: deterministic asset paths, partial audio and thumbnail command construction, FFprobe duration validation, and asset acquisition.
- `scripts/youtube-media-core.test.mjs`: command safety, path, duration, and acquisition tests.
- `scripts/audiogram-render-core.mjs`: render props, Remotion command construction, artifact validation, and rendering.
- `scripts/audiogram-render-core.test.mjs`: props and render command tests.
- `scripts/audiogram-processing-core.mjs`: state-driven acquisition and rendering orchestration.
- `scripts/audiogram-processing-core.test.mjs`: end-to-end orchestration with injected dependencies.

### Modified files

- `scripts/audiogram-ledger.mjs`: schema migration, pending-clip queries, and clip/job state transitions.
- `scripts/audiogram-ledger.test.mjs`: migration, resume, render, failure, and multi-clip tests.
- `scripts/youtube-pipeline.mjs`: run asset/render processing after playlist sync and heatmap selection.
- `src/Audiogram/schema.ts`: dynamic title and public-relative asset fields.
- `src/Audiogram/Main.tsx`: render supplied title, thumbnail, and audio.
- `src/Root.tsx`: resolve public-relative files and derive duration/captions from them.
- `.gitignore`: ignore `public/generated`.
- `docs/PROJECT_STATUS.md`: record completed V1 and planned V2 Whisper fallback after live verification.

---

### Task 1: Resumable SQLite clip state

**Files:**

- Modify: `scripts/audiogram-ledger.mjs:29-254`
- Modify: `scripts/audiogram-ledger.test.mjs`

**Interfaces:**

- Produces: `listPendingMediaClips(): ClipWorkItem[]`
- Produces: `listPendingRenderClips(): ClipWorkItem[]`
- Produces: `markClipMediaReady({clipId, mediaRelativePath, captionsRelativePath, thumbnailRelativePath, captionSource}): void`
- Produces: `markClipRendered({clipId, artifactRelativePath}): void`
- Produces: `markClipFailed({clipId, error}): void`
- `ClipWorkItem` contains `id`, `processingJobId`, `videoId`, `title`, `sourceUrl`, `treatmentVersion`, `rank`, `startSeconds`, `endSeconds`, `status`, and nullable asset paths.

- [ ] **Step 1: Add failing migration and state-transition tests**

Add tests that create the pre-V1 `clips` schema manually, reopen it through
`openAudiogramLedger()`, and assert that existing rows survive with the new
columns set to `null`. Add a second test that starts with two selected clips and
asserts these transitions:

```js
ledger.markClipMediaReady({
  clipId: first.id,
  mediaRelativePath: "public/generated/video-1/v1/clip-01/audio.wav",
  captionsRelativePath: "public/generated/video-1/v1/clip-01/captions.json",
  thumbnailRelativePath: "public/generated/video-1/v1/clip-01/thumbnail.jpg",
  captionSource: "youtube_creator",
});

assert.equal(ledger.listPendingMediaClips().length, 1);
assert.equal(ledger.listPendingRenderClips().length, 1);

ledger.markClipRendered({
  clipId: first.id,
  artifactRelativePath: "out/audiograms/video-1/v1/clip-01.mp4",
});

assert.equal(ledger.getProcessingJob("video-1", "v1").status, "heatmap_ready");
```

Then render the second clip and assert the processing job becomes `rendered`.
Add a failure assertion verifying both the clip and parent job become `failed`
and preserve the exact error text.

- [ ] **Step 2: Run the focused ledger tests and verify they fail**

Run:

```console
node --test scripts/audiogram-ledger.test.mjs
```

Expected: FAIL because the migration columns and state methods do not exist.

- [ ] **Step 3: Implement idempotent column migrations**

After the table creation SQL, inspect columns and add only missing fields:

```js
const ensureClipColumn = (name, definition) => {
  const columns = database.prepare("PRAGMA table_info(clips)").all();
  if (!columns.some((column) => column.name === name)) {
    database.exec(`ALTER TABLE clips ADD COLUMN ${name} ${definition}`);
  }
};

ensureClipColumn("media_relative_path", "TEXT");
ensureClipColumn("captions_relative_path", "TEXT");
ensureClipColumn("thumbnail_relative_path", "TEXT");
ensureClipColumn("caption_source", "TEXT");
ensureClipColumn("last_error", "TEXT");
```

Also include these columns in the `CREATE TABLE IF NOT EXISTS clips` definition
for new databases and in `mapClip()` using camelCase names.

- [ ] **Step 4: Implement pending queries and atomic transitions**

Join `clips`, `processing_jobs`, and `videos`. `listPendingMediaClips()` selects
`clips.status = 'selected'`; `listPendingRenderClips()` selects
`clips.status = 'media_ready'`. Order both by job ID and rank.

`markClipRendered()` must use one transaction:

```sql
UPDATE clips
SET status = 'rendered', artifact_relative_path = ?, last_error = NULL,
    updated_at = ?
WHERE id = ?;

UPDATE processing_jobs
SET status = 'rendered', last_error = NULL, updated_at = ?
WHERE id = (SELECT processing_job_id FROM clips WHERE id = ?)
  AND NOT EXISTS (
    SELECT 1 FROM clips sibling
    WHERE sibling.processing_job_id = processing_jobs.id
      AND sibling.status <> 'rendered'
  );
```

`markClipFailed()` must update the clip and its parent job in one transaction.

- [ ] **Step 5: Run the ledger tests and full YouTube suite**

Run:

```console
node --test scripts/audiogram-ledger.test.mjs
npm run test:youtube
```

Expected: all ledger tests and the existing 12-test baseline pass.

- [ ] **Step 6: Commit the ledger checkpoint**

```console
git add scripts/audiogram-ledger.mjs scripts/audiogram-ledger.test.mjs
git commit -m "feat: add resumable clip processing state"
```

---

### Task 2: YouTube caption acquisition and clip-local captions

**Files:**

- Create: `scripts/youtube-captions-core.mjs`
- Create: `scripts/youtube-captions-core.test.mjs`

**Interfaces:**

- Produces: `trimAndRebaseCaptions(captions, {startSeconds, endSeconds}): Caption[]`
- Produces: `acquireYoutubeCaptions({url, outputBase, startSeconds, endSeconds, run, fileOps}): Promise<{captionsPath, source}>`
- `source` is exactly `youtube_creator` or `youtube_auto`.

- [ ] **Step 1: Write failing caption transformation tests**

Cover captions before, inside, crossing both boundaries, and after the selected
interval. Use this expected result:

```js
assert.deepEqual(
  trimAndRebaseCaptions(
    [
      {
        text: " before",
        startMs: 1_000,
        endMs: 2_000,
        timestampMs: null,
        confidence: null,
      },
      {
        text: " crossing",
        startMs: 9_500,
        endMs: 10_500,
        timestampMs: null,
        confidence: null,
      },
      {
        text: " inside",
        startMs: 12_000,
        endMs: 13_000,
        timestampMs: 12_400,
        confidence: null,
      },
      {
        text: " ending",
        startMs: 19_500,
        endMs: 20_500,
        timestampMs: null,
        confidence: null,
      },
    ],
    { startSeconds: 10, endSeconds: 20 },
  ),
  [
    {
      text: " crossing",
      startMs: 0,
      endMs: 500,
      timestampMs: null,
      confidence: null,
    },
    {
      text: " inside",
      startMs: 2_000,
      endMs: 3_000,
      timestampMs: 2_400,
      confidence: null,
    },
    {
      text: " ending",
      startMs: 9_500,
      endMs: 10_000,
      timestampMs: null,
      confidence: null,
    },
  ],
);
```

- [ ] **Step 2: Write failing creator-first fallback tests**

Inject a fake `run()` and file operations. Assert the first yt-dlp call contains
`--skip-download`, `--write-subs`, `--sub-langs`, `en`, and `--sub-format`, `srt`.
When the creator SRT exists, assert no auto-caption command runs. When it does
not exist, assert the second call replaces `--write-subs` with
`--write-auto-subs`. When neither file exists, assert an error containing
`No English YouTube captions available`.

- [ ] **Step 3: Run the caption tests and verify they fail**

Run:

```console
node --test scripts/youtube-captions-core.test.mjs
```

Expected: FAIL with a module-not-found error.

- [ ] **Step 4: Implement transformation and acquisition**

Use `parseSrt` from `@remotion/captions`. Build yt-dlp arguments as arrays. Use
separate creator and automatic invocations, both with `--skip-download` and
`--no-playlist`. Parse the produced SRT, rebase it, and write
`captions.json` beside the source SRT:

```js
const clipStartMs = startSeconds * 1_000;
const clipEndMs = endSeconds * 1_000;

return captions
  .filter(({ startMs, endMs }) => endMs > clipStartMs && startMs < clipEndMs)
  .map((caption) => ({
    ...caption,
    startMs: Math.max(caption.startMs, clipStartMs) - clipStartMs,
    endMs: Math.min(caption.endMs, clipEndMs) - clipStartMs,
    timestampMs:
      caption.timestampMs === null
        ? null
        : Math.max(0, Math.min(caption.timestampMs, clipEndMs) - clipStartMs),
  }));
```

Reject an empty transformed caption list.

- [ ] **Step 5: Run caption tests and the full suite**

Run:

```console
node --test scripts/youtube-captions-core.test.mjs
npm run test:youtube
```

Expected: all tests pass.

- [ ] **Step 6: Commit the caption checkpoint**

```console
git add scripts/youtube-captions-core.mjs scripts/youtube-captions-core.test.mjs
git commit -m "feat: acquire and rebase YouTube captions"
```

---

### Task 3: Partial audio, thumbnail, and asset validation

**Files:**

- Create: `scripts/youtube-media-core.mjs`
- Create: `scripts/youtube-media-core.test.mjs`
- Modify: `.gitignore:6-8`

**Interfaces:**

- Consumes: `acquireYoutubeCaptions()` from Task 2.
- Produces: `getClipAssetPaths({projectRoot, videoId, treatmentVersion, rank})`.
- Produces: `buildPartialAudioArgs({url, startSeconds, endSeconds, outputTemplate})`.
- Produces: `validatePartialDuration({actualSeconds, expectedSeconds, toleranceSeconds}): void`.
- Produces: `acquireClipAssets(workItem, {projectRoot, run, fileOps}): Promise<MediaReadyPaths>`.
- `MediaReadyPaths` contains project-relative media, captions, thumbnail paths and `captionSource`.

- [ ] **Step 1: Write failing deterministic-path and command-safety tests**

Assert rank 1 becomes `clip-01`, all persisted paths use `/` separators and are
relative to the project, and the audio arguments include:

```js
[
  "--no-playlist",
  "--download-sections",
  "*882.2-902.25",
  "--extract-audio",
  "--audio-format",
  "wav",
];
```

Assert the URL is the final argument and that no alternate command builder can
omit the section restriction.

- [ ] **Step 2: Write failing duration and orchestration tests**

Test that `20.05` seconds passes for an expected `20.05` seconds with a `2.5`
second tolerance; `1_000` seconds throws an error containing
`Partial audio duration validation failed`. Inject runners that create fake
audio, caption, and thumbnail files and assert `acquireClipAssets()` returns only
project-relative paths.

- [ ] **Step 3: Run media tests and verify they fail**

Run:

```console
node --test scripts/youtube-media-core.test.mjs
```

Expected: FAIL with a module-not-found error.

- [ ] **Step 4: Implement deterministic asset paths and partial audio**

Use `path.join()` for filesystem paths and `path.relative()` followed by
separator normalization for ledger paths. Reject any relative result beginning
with `..` or becoming absolute.

Run yt-dlp through `execFile` with:

```js
[
  "--no-warnings",
  "--no-playlist",
  "--download-sections",
  `*${startSeconds}-${endSeconds}`,
  "--extract-audio",
  "--audio-format",
  "wav",
  "--output",
  outputTemplate,
  "--",
  url,
];
```

Probe the resulting `audio.wav` with:

```console
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 <audio-path>
```

- [ ] **Step 5: Implement thumbnail and complete asset acquisition**

Use a separate media-disabled yt-dlp invocation with `--write-thumbnail` and
`--convert-thumbnails jpg`. Normalize the produced file to `thumbnail.jpg`, then
call `acquireYoutubeCaptions()`. Validate all three final files are non-empty.

Add this ignore rule:

```gitignore
public/generated
```

- [ ] **Step 6: Run media tests and the full suite**

Run:

```console
node --test scripts/youtube-media-core.test.mjs
npm run test:youtube
```

Expected: all tests pass and no test creates repository media.

- [ ] **Step 7: Commit the media checkpoint**

```console
git add .gitignore scripts/youtube-media-core.mjs scripts/youtube-media-core.test.mjs
git commit -m "feat: acquire validated partial audiogram assets"
```

---

### Task 4: Parameterize the Remotion audiogram

**Files:**

- Modify: `src/Audiogram/schema.ts:30-49`
- Modify: `src/Audiogram/Main.tsx:17-134`
- Modify: `src/Root.tsx:9-62`

**Interfaces:**

- Consumes render props `{title, audioFileName, captionsFileName, coverImageFileName}`.
- Preserves visualizer, colors, and caption presentation fields.
- Produces composition ID `Audiogram` with duration derived from partial audio.

- [ ] **Step 1: Update the schema before component code and confirm TypeScript fails**

Replace `audioFileUrl` with these required fields:

```ts
title: z.string().min(1),
audioFileName: z.string().min(1),
captionsFileName: z.string().endsWith(".json"),
coverImageFileName: z.string().min(1),
```

Run:

```console
npm run lint
```

Expected: FAIL because `Root.tsx` and `Main.tsx` still use `audioFileUrl` and the
hard-coded title/cover.

- [ ] **Step 2: Make `Main.tsx` consume dynamic props**

Resolve public assets inside the component:

```tsx
const audioFileUrl = staticFile(audioFileName);
const coverImageUrl = staticFile(coverImageFileName);
```

Use `coverImageUrl` for `<Img>`, render `{title}` in the interactive title div,
and pass `audioFileUrl` to `<Audio>`, `<Oscilloscope>`, and `<Spectrum>`. Do not
change waveform colors, sample count, or progress behavior.

- [ ] **Step 3: Update `Root.tsx` defaults and metadata calculation**

Use inline default props:

```tsx
title: "Ep 550 - Supper Club × Remotion React",
audioFileName: "dialogue.wav",
captionsFileName: "captions.json",
coverImageFileName: "podcast-cover.jpeg",
captions: null,
```

Within `calculateMetadata`, resolve the audio and captions using `staticFile()`.
Keep Mediabunny duration calculation and return:

```ts
return {
  durationInFrames: Math.ceil(durationInSeconds * FPS),
  defaultOutName: `${props.audioFileName.replace(/[^a-zA-Z0-9_-]+/g, "-")}.mp4`,
  props: { ...props, captions },
  fps: FPS,
};
```

- [ ] **Step 4: Run TypeScript, lint, and composition discovery**

Run:

```console
npm run lint
npx remotion compositions
```

Expected: both commands exit 0 and list composition `Audiogram` at 1080 by 1080.

- [ ] **Step 5: Commit the Remotion parameterization checkpoint**

```console
git add src/Audiogram/schema.ts src/Audiogram/Main.tsx src/Root.tsx
git commit -m "feat: parameterize audiogram source assets"
```

---

### Task 5: Remotion rendering adapter

**Files:**

- Create: `scripts/audiogram-render-core.mjs`
- Create: `scripts/audiogram-render-core.test.mjs`

**Interfaces:**

- Produces: `createRenderProps(workItem, mediaReadyPaths): AudiogramRenderProps`.
- Produces: `buildRemotionRenderArgs({artifactPath, propsPath}): string[]`.
- Produces: `renderAudiogram(workItem, mediaReadyPaths, {projectRoot, run, fileOps}): Promise<{artifactRelativePath}>`.

- [ ] **Step 1: Write failing props and command tests**

Assert the props file contains the database title and public-relative names with
the leading `public/` removed:

```js
assert.deepEqual(props, {
  title: "A video",
  audioFileName: "generated/video-1/v1/clip-01/audio.wav",
  captionsFileName: "generated/video-1/v1/clip-01/captions.json",
  coverImageFileName: "generated/video-1/v1/clip-01/thumbnail.jpg",
});
```

Assert render arguments equal:

```js
[
  "--no-install",
  "remotion",
  "render",
  "Audiogram",
  artifactPath,
  `--props=${propsPath}`,
];
```

Add tests rejecting asset paths outside `public/` and an empty artifact.

- [ ] **Step 2: Run render-adapter tests and verify they fail**

Run:

```console
node --test scripts/audiogram-render-core.test.mjs
```

Expected: FAIL with a module-not-found error.

- [ ] **Step 3: Implement props writing and rendering**

Write formatted JSON to the deterministic `render-props.json`. Create the output
directory, invoke `npx` through `execFile` using the exact arguments above, then
`stat()` the artifact and require `size > 0`. Return the normalized
project-relative artifact path only after validation.

- [ ] **Step 4: Run render-adapter tests and full validation**

Run:

```console
node --test scripts/audiogram-render-core.test.mjs
npm run test:youtube
npm run lint
```

Expected: all commands pass.

- [ ] **Step 5: Commit the rendering checkpoint**

```console
git add scripts/audiogram-render-core.mjs scripts/audiogram-render-core.test.mjs
git commit -m "feat: add deterministic audiogram renderer"
```

---

### Task 6: State-driven pipeline orchestration

**Files:**

- Create: `scripts/audiogram-processing-core.mjs`
- Create: `scripts/audiogram-processing-core.test.mjs`
- Modify: `scripts/youtube-pipeline.mjs:179-211`

**Interfaces:**

- Consumes: ledger methods from Task 1.
- Consumes: `acquireClipAssets()` from Task 3.
- Consumes: `renderAudiogram()` from Task 5.
- Produces: `processPendingAudiograms({ledger, projectRoot, acquireAssets, render}): Promise<{acquired, rendered, failed}>`.

- [ ] **Step 1: Write failing happy-path and resume tests**

With a fake ledger, assert a selected clip calls acquisition, records
`media_ready`, then renders and records `rendered`. Add a second case beginning
at `media_ready` and assert acquisition is never called. Add a third case with a
rendered clip and assert neither dependency is called.

- [ ] **Step 2: Write failing error-isolation test**

Provide two selected clips. Make the first acquisition throw `range refused` and
the second succeed. Assert `markClipFailed()` receives the first error, the
second clip renders, and the result contains one failure so the CLI can exit
non-zero.

- [ ] **Step 3: Run orchestration tests and verify they fail**

Run:

```console
node --test scripts/audiogram-processing-core.test.mjs
```

Expected: FAIL with a module-not-found error.

- [ ] **Step 4: Implement two-pass orchestration**

First iterate `ledger.listPendingMediaClips()`, acquiring and recording each clip
independently. Then query `ledger.listPendingRenderClips()` so newly acquired and
previously media-ready clips render in the same run. Return summaries without
including full stderr or secrets.

- [ ] **Step 5: Connect orchestration to `youtube-pipeline.mjs`**

After `syncAndAnalyzeInbox()`, call:

```js
const artifacts = await processPendingAudiograms({
  ledger,
  projectRoot: process.cwd(),
});
```

Include `artifacts` in the JSON summary. Set `process.exitCode = 1` when either
heatmap analysis or artifact processing reports failures. Keep the existing OAuth
and playlist behavior unchanged.

- [ ] **Step 6: Run all automated checks**

Run:

```console
npm run test:youtube
npm run lint
npx remotion compositions
```

Expected: all tests pass, lint/TypeScript exit 0, and `Audiogram` is discoverable.

- [ ] **Step 7: Commit the orchestration checkpoint**

```console
git add scripts/audiogram-processing-core.mjs scripts/audiogram-processing-core.test.mjs scripts/youtube-pipeline.mjs
git commit -m "feat: process selected clips into audiograms"
```

---

### Task 7: Live MVP render and idempotency proof

**Files:**

- Runtime create, ignored: `public/generated/KHd-luu3M8s/v1/clip-01/*`
- Runtime create, ignored: `out/audiograms/KHd-luu3M8s/v1/clip-01.mp4`
- Modify after success: `docs/PROJECT_STATUS.md`

**Interfaces:**

- Exercises the public command `npm run youtube:inbox`.
- Verifies the persistent ledger at `~/Library/Application Support/Audiogram Inbox/audiograms.sqlite`.

- [ ] **Step 1: Record the pre-run ledger state**

Run a read-only SQLite query for video `KHd-luu3M8s`. Expected state:
`processing_jobs.status = 'heatmap_ready'`, rank 1 starts at `882.2`, ends at
`902.25`, and `artifact_relative_path` is null.

- [ ] **Step 2: Run the live pipeline once**

Run:

```console
npm run youtube:inbox
```

Expected: creator English captions, partial audio acquisition, thumbnail
acquisition, and one Remotion render complete. If the first external command
fails, stop and report that exact failure instead of changing acquisition scope.

- [ ] **Step 3: Validate acquired media and artifact**

Use FFprobe to check `audio.wav` is approximately `20.05` seconds and the MP4 has
video and audio streams. Confirm there is no source-duration media file in the
generated directory.

- [ ] **Step 4: Render and inspect a representative frame**

Render or extract a frame near the middle of the artifact and inspect it. Verify
the real title and thumbnail are visible, captions are non-empty, and the gray
waveform with white progress overlay remains legible.

- [ ] **Step 5: Verify ledger completion**

Query SQLite and require:

```text
job status: rendered
clip status: rendered
media_relative_path: public/generated/KHd-luu3M8s/v1/clip-01/audio.wav
captions_relative_path: public/generated/KHd-luu3M8s/v1/clip-01/captions.json
thumbnail_relative_path: public/generated/KHd-luu3M8s/v1/clip-01/thumbnail.jpg
caption_source: youtube_creator
artifact_relative_path: out/audiograms/KHd-luu3M8s/v1/clip-01.mp4
```

- [ ] **Step 6: Run the pipeline a second time**

Run:

```console
npm run youtube:inbox
```

Expected: the video remains existing, with zero heatmap analyses, zero
acquisitions, and zero renders.

- [ ] **Step 7: Run final automated verification**

Run:

```console
npm run test:youtube
npm run lint
npx remotion compositions
```

Expected: every command exits 0.

- [ ] **Step 8: Update the project handoff**

Update `docs/PROJECT_STATUS.md` with the completed partial acquisition and render
stages, exact artifact location, verification evidence, and V2 caption fallback:

```text
creator English captions -> automatic English captions -> local Whisper
```

Record that V2 stores reusable Whisper binaries and model weights under
`~/Library/Application Support/Audiogram Inbox/models/whisper/` and transcribes
only validated partial audio.

- [ ] **Step 9: Commit the verified MVP documentation**

```console
git add docs/PROJECT_STATUS.md
git commit -m "docs: record verified audiogram MVP"
```

---

## Final review checklist

- [ ] Inspect `git status --short` and confirm unrelated `.agents/`, `.claude/`,
      and `skills-lock.json` files were not committed.
- [ ] Inspect the commit list and confirm each checkpoint contains only its task
      files.
- [ ] Confirm no OAuth JSON, token, SQLite database, generated media, or artifact
      was added to Git.
- [ ] Confirm the design spec's nine acceptance criteria all have corresponding
      live or automated evidence.
- [ ] Confirm V2 Whisper behavior exists only in documentation, not the V1 code
      path.
