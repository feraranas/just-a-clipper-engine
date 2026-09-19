# Clip Package and Treatment Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. For this V1, execute inline with
> superpowers:executing-plans, as explicitly chosen by the user.

**Goal:** Produce one duplicate-safe `audiogram-basic@1` MP4 from each selected
YouTube heatmap interval through reusable, treatment-independent clip packages.

**Architecture:** Migrate the ledger from treatment-scoped jobs and clips to
package jobs, reusable package assets, and separate treatment runs. Build assets
with focused yt-dlp/FFprobe helpers, select an explicit treatment from a code
registry, and run Remotion through a generic renderer that knows only the
treatment definition and package contract.

**Tech Stack:** Node.js 22 ESM, built-in `node:sqlite`, Node test runner,
yt-dlp 2026.08.19, FFmpeg/FFprobe 8.1, Remotion 4.0.525, React 19,
`@remotion/captions`, Mediabunny, Zod.

**Spec:** `docs/superpowers/specs/2026-09-18-clip-package-treatment-registry-design.md`

## Global Constraints

- V1 registers only `audiogram-basic@1`.
- Package version and treatment version are separate identities.
- The schema supports multiple ranked packages while V1 defaults to rank 1.
- V1 uses creator English captions, then automatic English captions; it never
  invokes Whisper.
- Every audio acquisition command includes `--download-sections` and
  `--extract-audio`.
- Never fall back to downloading a complete source video.
- Persist project-relative paths; never persist checkout-specific absolute
  paths.
- Keep generated inputs under
  `public/generated/<video-id>/<package-version>/clip-<rank>/`.
- Keep artifacts under
  `out/treatments/<treatment-id>/<treatment-version>/<video-id>/clip-<rank>.mp4`.
- Do not commit credentials, tokens, generated media, model weights, or
  rendered artifacts.
- Preserve the 1080x1080 layout, 32-sample gray waveform, and advancing white
  progress effect.
- Failed packages and treatment runs are terminal for automatic V1 runs.
- Implement every behavior test-first and commit after every task.

---

## File structure

### New files

- `scripts/treatment-registry.mjs`: registry construction, requirement
  validation, public-path conversion, and `audiogram-basic@1`.
- `scripts/treatment-registry.test.mjs`: duplicate identity, unknown lookup,
  missing assets, and props mapping.
- `scripts/clip-package-assets.mjs`: deterministic paths, yt-dlp commands,
  SRT conversion, FFprobe validation, and package materialization.
- `scripts/clip-package-assets.test.mjs`: command safety, timestamp rebasing,
  output validation, and creator/automatic caption fallback.
- `scripts/treatment-runner.mjs`: render paths, props files, Remotion command,
  temporary output validation, and atomic promotion.
- `scripts/treatment-runner.test.mjs`: missing-asset short circuit, render
  success, and render failure isolation.
- `scripts/clip-processing-core.mjs`: state-driven acquisition and treatment
  orchestration with injected effects.
- `scripts/clip-processing-core.test.mjs`: end-to-end idempotency and failure
  boundary tests.

### Modified files

- `scripts/audiogram-ledger.mjs`: transactional legacy migration and generic
  package/treatment APIs.
- `scripts/audiogram-ledger.test.mjs`: migration, package, asset, treatment,
  and multi-rank tests.
- `scripts/youtube-inbox-pipeline-core.mjs`: package-version vocabulary.
- `scripts/youtube-inbox-pipeline-core.test.mjs`: package-version assertions.
- `scripts/youtube-pipeline.mjs`: run acquisition and rendering after heatmap
  selection.
- `src/Audiogram/schema.ts`: dynamic title and public-relative asset names.
- `src/Audiogram/Main.tsx`: render package title, thumbnail, audio, and
  captions.
- `src/Root.tsx`: register `AudiogramBasic` and derive dynamic metadata.
- `.gitignore`: ignore `public/generated`.
- `docs/PROJECT_STATUS.md`: document the completed V1 pipeline after live
  verification.

---

### Task 1: Generic SQLite ledger and transactional migration

**Files:**

- Modify: `scripts/audiogram-ledger.mjs`
- Modify: `scripts/audiogram-ledger.test.mjs`

**Interfaces:**

- Produces: `syncPlaylistVideos({playlistId, packageVersion, videos})`
- Produces: `getPackageJob(videoId, packageVersion)`
- Produces: `listPendingPackageJobs()`
- Produces: `recordHeatmapSelection({jobId, heatmap, packages})`
- Produces: `listClipPackages(jobId)`
- Produces: `listSelectedPackages()`
- Produces: `getClipPackage(packageId)`
- Produces: `markPackageReady({packageId, assets})`
- Produces: `markPackageFailed(packageId, error)`
- Produces: `ensureTreatmentRun({clipPackageId, treatmentId, treatmentVersion})`
- Produces: `listPendingTreatmentRuns({treatmentId, treatmentVersion})`
- Produces: `markTreatmentRunRendered({runId, artifactRelativePath})`
- Produces: `markTreatmentRunFailed(runId, error)`

- [ ] **Step 1: Write a failing legacy-migration test**

Create a database with the exact pre-migration `videos`, `processing_jobs`,
and `clips` tables, insert one heatmap-ready selected clip and one rendered
clip, then open it through `openAudiogramLedger()`:

```js
const migrated = openAudiogramLedger(path, {now});
assert.equal(migrated.getPackageJob("video-1", "v1").status, "heatmap_ready");
assert.equal(migrated.listClipPackages(jobId)[0].status, "selected");
assert.equal(migrated.listClipPackages(jobId)[1].status, "ready");
assert.equal(migrated.listTreatmentRuns(packageId)[0].treatmentId, "audiogram-basic");
```

- [ ] **Step 2: Run the migration test and verify RED**

Run: `node --test --test-name-pattern="migrates legacy" scripts/audiogram-ledger.test.mjs`

Expected: FAIL because the generic tables and APIs do not exist.

- [ ] **Step 3: Implement the transactional schema migration**

Create STRICT `package_jobs`, `clip_packages`, `clip_assets`, and
`treatment_runs` tables. Copy legacy rows in one `BEGIN IMMEDIATE`
transaction, map legacy states exactly as specified, validate row counts, drop
legacy tables only after validation, and roll back on any error.

- [ ] **Step 4: Run the migration test and verify GREEN**

Run: `node --test --test-name-pattern="migrates legacy" scripts/audiogram-ledger.test.mjs`

Expected: PASS.

- [ ] **Step 5: Write failing package and treatment state tests**

Cover multi-rank packages, asset persistence, duplicate-safe treatment runs,
ready-package reuse, render completion, package failure, and treatment failure.
Assert the unique keys `(video_id, package_version)`,
`(package_job_id, rank)`, `(clip_package_id, role)`, and
`(clip_package_id, treatment_id, treatment_version)`.

- [ ] **Step 6: Run the new ledger tests and verify RED**

Run: `node --test scripts/audiogram-ledger.test.mjs`

Expected: FAIL on missing generic ledger methods.

- [ ] **Step 7: Implement the generic ledger API**

Return package objects with:

```js
{
  id,
  packageJobId,
  packageVersion,
  source: {videoId, title, sourceUrl},
  interval: {rank, startSeconds, endSeconds, score},
  status,
  lastError,
  assets: {audio: {relativePath, provenance, metadata}, ...}
}
```

All multi-row state changes use explicit transactions.

- [ ] **Step 8: Run ledger and importer tests**

Run: `npm run test:youtube`

Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add scripts/audiogram-ledger.mjs scripts/audiogram-ledger.test.mjs scripts/youtube-inbox-pipeline-core.mjs scripts/youtube-inbox-pipeline-core.test.mjs
git commit -m "feat: migrate ledger to reusable clip packages"
```

---

### Task 2: Explicit treatment registry

**Files:**

- Create: `scripts/treatment-registry.mjs`
- Create: `scripts/treatment-registry.test.mjs`

**Interfaces:**

- Consumes: the `ClipPackage` shape from Task 1.
- Produces: `createTreatmentRegistry(definitions)`
- Produces: `audiogramBasicTreatment`
- Produces: `treatmentRegistry`
- Produces: `assertRequiredAssets(treatment, clipPackage)`

- [ ] **Step 1: Write failing registry tests**

```js
assert.throws(
  () => createTreatmentRegistry([definition, definition]),
  /Duplicate treatment audiogram-basic@1/,
);
assert.throws(() => registry.get("missing", "1"), /Unknown treatment missing@1/);
assert.deepEqual(
  audiogramBasicTreatment.buildInputProps(packageWithAssets),
  {
    title: "Example",
    audioFileName: "generated/video-1/v1/clip-1/audio.wav",
    captionsFileName: "generated/video-1/v1/clip-1/captions.json",
    coverImageFileName: "generated/video-1/v1/clip-1/thumbnail.jpg",
  },
);
```

Also assert that missing `audio`, `captions`, or `thumbnail` is reported
before rendering.

- [ ] **Step 2: Run registry tests and verify RED**

Run: `node --test scripts/treatment-registry.test.mjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the registry**

Use a `Map` keyed by `${id}@${version}`. Validate non-empty identity,
composition ID, unique required assets, callable `buildInputProps`, and output
codec/extension. Convert only paths beginning with `public/` into
Remotion-public-relative names.

- [ ] **Step 4: Run registry tests and verify GREEN**

Run: `node --test scripts/treatment-registry.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/treatment-registry.mjs scripts/treatment-registry.test.mjs
git commit -m "feat: add explicit treatment registry"
```

---

### Task 3: Partial package asset acquisition

**Files:**

- Create: `scripts/clip-package-assets.mjs`
- Create: `scripts/clip-package-assets.test.mjs`
- Modify: `.gitignore`

**Interfaces:**

- Consumes: selected `ClipPackage` records from Task 1.
- Produces: `getPackagePaths({projectRoot, clipPackage})`
- Produces: `buildPartialAudioArgs({url, startSeconds, endSeconds, outputTemplate})`
- Produces: `buildCaptionArgs({url, automatic, outputTemplate})`
- Produces: `buildThumbnailArgs({url, outputTemplate})`
- Produces: `trimAndRebaseCaptions(captions, interval)`
- Produces: `probeDuration(path, options)`
- Produces: `materializeClipPackage({clipPackage, projectRoot, run})`

- [ ] **Step 1: Write failing command-construction tests**

Assert partial audio arguments contain all of:

```js
[
  "--no-playlist",
  "--download-sections", "*10-30",
  "--extract-audio",
  "--audio-format", "wav",
  "--output", outputTemplate,
  "--", sourceUrl,
]
```

Assert no code path builds an audio command without the time section. Assert
caption commands use `--skip-download`, creator captions first and automatic
captions second. Assert thumbnail commands use `--skip-download`.

- [ ] **Step 2: Write failing caption timestamp tests**

Given captions spanning before, inside, and after a 10-30 second interval,
expect only overlapping captions, clamped to `0..20000` milliseconds and
rebased so the interval starts at zero.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `node --test scripts/clip-package-assets.test.mjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 4: Implement deterministic paths and pure helpers**

Use `public/generated/<video-id>/<package-version>/clip-<rank>/`. Sanitize
path segments to letters, numbers, dot, underscore, and hyphen. Parse SRT with
`parseSrt()` and write Remotion `Caption[]` JSON.

- [ ] **Step 5: Implement materialization with injected process execution**

Create the package directory, download partial WAV audio, validate non-empty
files, probe duration with FFprobe, acquire creator SRT with automatic SRT as
fallback, write rebased JSON, acquire/normalize JPEG thumbnail, and write
`package.json`. Return exactly three asset records with project-relative paths.

Accept duration drift of at most three seconds from the selected interval.
Throw rather than retrying without range flags.

- [ ] **Step 6: Run asset tests and verify GREEN**

Run: `node --test scripts/clip-package-assets.test.mjs`

Expected: PASS.

- [ ] **Step 7: Run the complete test suite**

Run: `npm run test:youtube`

Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add .gitignore scripts/clip-package-assets.mjs scripts/clip-package-assets.test.mjs
git commit -m "feat: materialize reusable clip package assets"
```

---

### Task 4: Generic treatment renderer

**Files:**

- Create: `scripts/treatment-runner.mjs`
- Create: `scripts/treatment-runner.test.mjs`

**Interfaces:**

- Consumes: `TreatmentDefinition` from Task 2 and ready packages from Task 1.
- Produces: `getTreatmentPaths({projectRoot, treatment, clipPackage})`
- Produces: `buildRemotionRenderArgs({treatment, propsPath, temporaryArtifactPath})`
- Produces: `renderTreatment({treatment, clipPackage, projectRoot, run})`

- [ ] **Step 1: Write failing render tests**

Assert missing assets prevent the injected process runner from being called.
For a complete package, assert:

```js
[
  "remotion",
  "render",
  "AudiogramBasic",
  temporaryArtifactPath,
  `--props=${propsPath}`,
  "--codec=h264",
]
```

Assert successful non-empty output is renamed atomically to the final path and a
thrown render error leaves package files untouched.

- [ ] **Step 2: Run render tests and verify RED**

Run: `node --test scripts/treatment-runner.test.mjs`

Expected: FAIL because the runner does not exist.

- [ ] **Step 3: Implement the generic renderer**

Write treatment props JSON under the treatment artifact directory. Render into
a `.partial.mp4` file in that same directory, validate non-zero size, rename it
to the deterministic final path, and return the project-relative artifact path.
Never branch on treatment ID.

- [ ] **Step 4: Run render tests and verify GREEN**

Run: `node --test scripts/treatment-runner.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/treatment-runner.mjs scripts/treatment-runner.test.mjs
git commit -m "feat: render registered treatments generically"
```

---

### Task 5: Dynamic `AudiogramBasic` composition

**Files:**

- Modify: `src/Audiogram/schema.ts`
- Modify: `src/Audiogram/Main.tsx`
- Modify: `src/Root.tsx`

**Interfaces:**

- Consumes props from `audiogramBasicTreatment.buildInputProps()`.
- Produces composition ID `AudiogramBasic`.
- Produces dynamic duration and loaded `Caption[]` via `calculateMetadata`.

- [ ] **Step 1: Update the schema before markup**

Add required `title`, `audioFileName`, `captionsFileName`, and
`coverImageFileName` fields. Keep `captions` as the internal nullable value
populated by `calculateMetadata`.

- [ ] **Step 2: Run TypeScript and verify RED**

Run: `npm run lint`

Expected: FAIL because existing default props and component props do not satisfy
the new schema.

- [ ] **Step 3: Implement dynamic composition props**

Rename the exported component to `AudiogramBasic`. Resolve public-relative
names with `staticFile()` inside Remotion, replace the hard-coded title and
cover image, and retain all waveform styling.

Register:

```tsx
<Composition
  id="AudiogramBasic"
  component={AudiogramBasic}
  width={1080}
  height={1080}
  schema={audiogramSchema}
  defaultProps={{
    title: "Audiogram preview",
    audioFileName: "dialogue.wav",
    captionsFileName: "captions.json",
    coverImageFileName: "podcast-cover.jpeg",
    captions: null,
    // existing styling and 32-sample oscilloscope settings
  }}
  calculateMetadata={...}
/>
```

Use `Math.ceil(durationInSeconds * FPS)`, dispose the Mediabunny input in a
`finally` block, and return loaded captions through transformed props.

- [ ] **Step 4: Run lint and composition discovery**

Run: `npm run lint`

Expected: PASS.

Run: `npx remotion compositions`

Expected: output contains `AudiogramBasic 30 1080x1080`.

- [ ] **Step 5: Commit**

```bash
git add src/Audiogram/schema.ts src/Audiogram/Main.tsx src/Root.tsx
git commit -m "feat: parameterize the basic audiogram treatment"
```

---

### Task 6: Idempotent end-to-end orchestration

**Files:**

- Create: `scripts/clip-processing-core.mjs`
- Create: `scripts/clip-processing-core.test.mjs`
- Modify: `scripts/youtube-inbox-pipeline-core.mjs`
- Modify: `scripts/youtube-inbox-pipeline-core.test.mjs`
- Modify: `scripts/youtube-pipeline.mjs`
- Modify: `docs/PROJECT_STATUS.md`

**Interfaces:**

- Consumes all Task 1-5 interfaces.
- Produces: `processClipPackages({ledger, treatment, acquireAssets, render})`
- `youtube-pipeline.mjs` remains the `npm run youtube:inbox` entry point.

- [ ] **Step 1: Write failing orchestration tests**

Test one selected package through acquisition and rendering with injected
effects. Run the orchestrator twice and assert acquisition and rendering are
each called once. Test acquisition failure marks the package failed without
creating a treatment run. Test render failure marks only the treatment run
failed while the package remains ready.

- [ ] **Step 2: Run orchestration tests and verify RED**

Run: `node --test scripts/clip-processing-core.test.mjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement state-driven orchestration**

For every selected package, call acquisition and persist assets atomically.
Create `audiogram-basic@1` runs only for ready packages. Render only pending
runs. Return a serializable summary with package and treatment outcomes.

- [ ] **Step 4: Rename package-version vocabulary**

Change importer functions to accept `packageVersion`. Read
`AUDIOGRAM_PACKAGE_VERSION`, fall back to the legacy
`AUDIOGRAM_TREATMENT_VERSION`, then default to `v1`. Treatment identity stays
fixed to the sole V1 registry entry.

- [ ] **Step 5: Connect real acquisition and rendering**

After heatmap analysis in `youtube-pipeline.mjs`, invoke
`processClipPackages()` with `materializeClipPackage()`,
`renderTreatment()`, the explicit registry entry, and the repository root.
Include both package version and treatment identity in JSON output. Set a
non-zero exit code for package or treatment failures.

- [ ] **Step 6: Run all automated checks**

Run: `npm run test:youtube`

Expected: all tests PASS.

Run: `npm run lint`

Expected: PASS.

Run: `npx remotion compositions`

Expected: output contains `AudiogramBasic`.

- [ ] **Step 7: Perform one live V1 run**

Run: `npm run youtube:inbox`

Expected: the selected interval is materialized without a full-video fallback,
the artifact exists at the deterministic treatment path, and the ledger records
the package and rendered treatment run.

Run the same command again.

Expected: no second heatmap request, acquisition, or render for completed work.

If the sandbox prevents Chromium from rendering, stop at the exact
`MachPortRendezvousServer... Permission denied (1100)` failure and run the
render command from normal macOS Terminal before claiming MP4 success.

- [ ] **Step 8: Update project status**

Record exact test counts, the live package path, artifact path, ledger state,
and idempotent rerun result. Do not claim a render if Step 7 did not produce and
validate the MP4.

- [ ] **Step 9: Commit**

```bash
git add scripts/clip-processing-core.mjs scripts/clip-processing-core.test.mjs scripts/youtube-inbox-pipeline-core.mjs scripts/youtube-inbox-pipeline-core.test.mjs scripts/youtube-pipeline.mjs docs/PROJECT_STATUS.md
git commit -m "feat: run the clip package pipeline end to end"
```

---

## Final verification and review

- [ ] Run `git diff --check origin/main...HEAD`.
- [ ] Run `npm run test:youtube`.
- [ ] Run `npm run lint`.
- [ ] Run `npx remotion compositions`.
- [ ] Inspect `git status --short` and confirm no generated assets are staged.
- [ ] Request one independent final code review against the merged spec.
- [ ] Resolve every valid review finding and rerun affected checks.
- [ ] Push the branch and open PR #2 with exact verification results.
