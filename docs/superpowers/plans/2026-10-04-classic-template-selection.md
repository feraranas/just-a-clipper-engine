# Classic Template Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline.
Follow the user's no-subagent policy.
Review the focused diff yourself.
Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the current portrait Audiogram as Classic V1 / Default.
Make selection explicit in rendering and the helper plugin.
Check output parity.

**Architecture:** Add a browser-safe catalog/resolver above the existing treatment registry.
Preserve `audiogram-basic@1`, `AudiogramBasic`, existing paths, and clip-package identity.
Propagate canonical selection through entry points, active jobs, rendering, manifests, failure reporting, and result collection.

**Tech Stack:** Existing Node ESM and node:test, SQLite, TypeScript/React, Remotion 4.0.525, Zod, FFmpeg/ffprobe.
No dependency upgrades or new production dependencies.

**Spec:** `docs/features/classic-template-selection.md`.
Read both documents before execution.
Use the definitions in the design note for technical terms.

## Global Constraints

- Existing composition ID, treatment ID/version and historical paths remain valid.
- Omission and explicit Classic Default have the same treatment, props and output.
- The first implementation exposes only Classic / Default.
- Clip selection and source assets can be reused across visual treatments.
- The first slice introduces no new visual style or publishing capability.
- Preserve 1080x1920 at 30 fps.
  Square support is not authorized by silence: its unanswered design question remains deferred, without blocking portrait preservation.
- Work inline, no delegated implementer or reviewer.
  Preserve unrelated files.
  Never reset or clean the checkout.
- The user approved the design by requesting this plan.
  Implementation starts after plan review.
- Keep the feature note DESIGN until actual implementation, tests, render comparison and reconciliation succeed.
- Existing source has Remotion 4.0.525 and `node:sqlite`.
  Check the installed runtime supports the existing test harness before starting.

## Review Focus

1.
   Unrelated failed/pending treatments for the same video must not affect the requested result (Task 3).
2.
   Two concurrent helper requests with different selections must not share a job or race shared asset acquisition (Task 5).
3.
   Legacy active jobs and completed records must survive repeat migration and reopening (Task 5).
4.
   Empty, null, unknown and mismatched selection fields must fail before side effects (Tasks 2, 4, 5).
5.
   The pipeline must reject historical success records with missing output files.
   Missing additive manifests must not invalidate valid legacy MP4s (Tasks 3, 4).

## File responsibilities

| Files | Responsibility |
| --- | --- |
| `src/templates/catalog.mjs`, `catalog.d.mts` (new) | Serializable catalog, canonical resolver, browser-safe public types |
| `src/templates/classic/defaults.json` (new) | Exact existing visual defaults. No content/asset filenames |
| `src/Root.tsx`, `scripts/treatment-registry.mjs` | Consume shared defaults and catalog metadata without renaming identities |
| `scripts/template-selection-config.mjs` (new) | Map explicit request/environment fields into the canonical resolver |
| `scripts/template-selection.test.mjs` (new) | Catalog, default and invalid-selection contracts |
| `scripts/clip-processing-core.mjs` | Execute only requested treatment identities |
| `scripts/single-url-pipeline.mjs` | Resolve early. Scope collection and failure aggregation |
| `scripts/treatment-runner.mjs` | Existing render path plus additive identity manifest |
| `scripts/audiogram-url.mjs`, `scripts/youtube-pipeline.mjs` | CLI and playlist selection adapters |
| `plugins/audiogram-helper/{server,local-runner,job-store,job-worker}.mjs` | MCP fields, canonical active-job identity, persisted selection and worker forwarding |
| Existing associated `.test.mjs` files. New `job-store.test.mjs`, `job-worker.test.mjs` | Regression and migration contracts |
| `scripts/verify-classic-parity.mjs`, `.test.mjs` (new) | Compare media metadata, decoded frame/audio hashes and fixture provenance |
| `tests/fixtures/classic-v1/` (new) | Deterministic synthetic inputs, props and baseline manifest. Clearly label sample content |
| `README.md`, `plugins/audiogram-helper/README.md`, feature note | User-facing selection, template admission and reconciliation |

## Task 1: Establish a reproducible pre-change baseline

**Files:** Create fixture generator/inputs under `tests/fixtures/classic-v1/`, `scripts/verify-classic-parity.mjs` and its test.
No product changes in this task.

**Interfaces:** Run `verify-classic-parity.mjs --baseline <mp4> --candidate <mp4> --manifest <json>`.
The command exits 0 only when all comparison values match:

- Dimensions and fps.
- Frame count.
- Hashes of decoded frames.
- Hashes of decoded audio.

The command exits nonzero at the first mismatch.
Missing audio on either side fails for this fixture.

- [ ] Check `pwd -P`, `git rev-parse --show-toplevel`, branch, HEAD and status.
- [ ] Inspect attached worktrees before creating isolation at execution time.
- [ ] Carry only the approved feature note and plan.
- [ ] Do not copy unrelated observability documents.
- [ ] Record the exact baseline commit.
- [ ] Re-inspect relevant changes if HEAD differs from `195a8f4418ba5eaf47806506b474f4d31d4fcbe1`.
- [ ] Create a deterministic 6-second fixture with generated PCM audio.
- [ ] Generate a simple SVG thumbnail locally.
- [ ] Mark the thumbnail `SYNTHETIC FIXTURE`.
- [ ] Use captions that span multiple pages.
- [ ] Include a long title.
- [ ] Copy the assets into `public/generated/classic-regression/` for rendering.
- [ ] Keep generated videos in the ignored directory `out/classic-regression/`.
- [ ] Use 16 kHz mono sine PCM at 440 Hz with fixed amplitude.
- [ ] Use fixed millisecond times for captions.
- [ ] Include enough words to exercise the actual page-break algorithm.
- [ ] Store the full fixture inputs rather than relying on downloads.
- [ ] Keep the generator deterministic.
- [ ] Hash its outputs.
- [ ] Write the fixture props in `tests/fixtures/classic-v1/props.json` using existing prop names and visual defaults from Root.
- [ ] Save input hashes in `baseline-manifest.json`.
- [ ] Include hashes of the package lock and loaded font files.
- [ ] Record the exact commit, browser executable/version and render command.
- [ ] Inspect font loading.
- [ ] Capture the font bytes without changing font loading during baseline capture.
- [ ] Fail with a clear error if both renders cannot use the same fonts.
- [ ] Before product edits, render the baseline using installed local tools:

```sh
./node_modules/.bin/remotion render AudiogramBasic out/classic-regression/baseline.mp4 --props=tests/fixtures/classic-v1/props.json --frames=0-179 --concurrency=1 --codec=h264
```

Keep the existing JPEG intermediate-frame configuration, codec and all settings identical for the candidate.
The inclusive frame range produces 180 frames.
Current CLI reference: https://www.remotion.dev/docs/cli/render (verified through Context7 during planning).

- [ ] Implement parity comparison using `execFile` argument arrays, never interpolated shell commands.
- [ ] Use ffprobe JSON and FFmpeg decoded hashes:

```js
const videoArgs = ['-v', 'error', '-i', file, '-map', '0:v:0',
  '-an', '-pix_fmt', 'rgb24', '-f', 'framemd5', '-'];
const audioArgs = ['-v', 'error', '-i', file, '-map', '0:a:0',
  '-vn', '-acodec', 'pcm_s16le', '-f', 'hash', '-hash', 'sha256', '-'];
```

Compare normalized frame records, excluding comment headers.
Compare decoded audio hashes and audio metadata.
Check the origin of the inputs.
Reject differences in fixture hashes or settings before attributing output differences to the refactor.
Export `compareParityRecords(baseline, candidate)` as a pure helper returning `{equal, reason}` for tests.

- [ ] Test equal records, a changed frame, changed audio, missing audio, changed fps/dimensions/frame count and missing input files.
- [ ] Run `node --test scripts/verify-classic-parity.test.mjs`.
- [ ] Compare the baseline to itself.
- [ ] Compare the baseline to a deliberately changed local copy.
- [ ] Check that the real command fails for the changed copy.
- [ ] Save a contact sheet at start, a caption page transition, an active-waveform frame, and the last frame.
- [ ] Inspect the contact sheet.
- [ ] Watch the short video.
- [ ] Stop if rendering, font loading or the runtime fails.
- [ ] Explain the failure.
- [ ] Never substitute a mock render for this baseline.
- [ ] Commit only the cohesive fixture/checker files and manifest (not private source media or generated MP4s).
- [ ] Retain the baseline video locally throughout execution.

## Task 2: Catalog, resolver and frozen Classic defaults

**Files:** Create the catalog, type declaration, defaults, configuration and test files from the file table.
Change `src/Root.tsx`, `scripts/treatment-registry.mjs`, `scripts/treatment-registry.test.mjs`.
Enable `resolveJsonModule` in `tsconfig.json` if required for the JSON import.

**Interfaces:**

```ts
type TemplateSelection = {
  templateId: string; templateVersion: string; variationId: string;
};
type ResolvedTemplateSelection = {
  selection: TemplateSelection;
  treatment: {id: string; version: string};
  compositionId: string;
  renderKey: string; // existing treatment identity, e.g. audiogram-basic@1
};
// Browser-safe functions, no fs/sqlite/process imports:
resolveTemplateSelection(input?: Partial<TemplateSelection>): ResolvedTemplateSelection;
listTemplates(): readonly TemplateCatalogEntry[];
// TemplateCatalogEntry has id, version, label, defaultVariationId and variations;
// each variation has id, label, treatment {id,version} and compositionId.
```

- [ ] Write failing resolver assertions including:

```js
assert.deepEqual(resolveTemplateSelection().selection,
  {templateId: 'classic', templateVersion: '1', variationId: 'default'});
assert.equal(resolveTemplateSelection().renderKey, 'audiogram-basic@1');
assert.deepEqual(resolveTemplateSelection(), resolveTemplateSelection({
  templateId: 'classic', templateVersion: '1', variationId: 'default'}));
for (const input of [null, {templateId: ''}, {variationId: null},
  {templateId: 'missing'}, {templateVersion: '2'}, {variationId: 'other'}]) {
  assert.throws(() => resolveTemplateSelection(input),
    {code: 'INVALID_TEMPLATE_SELECTION'});
}
```

- [ ] Implement a frozen catalog with one entry.
- [ ] Use Classic defaults for omitted fields.
- [ ] Check supplied values without trimming them into a different ID.
- [ ] Check all catalog treatment mappings against the Node registry in tests.
- [ ] Return fresh canonical data so callers cannot mutate global defaults.
- [ ] Extract only existing visual props: `titleColor`, `captionsTextColor`, `onlyDisplayCurrentSentence`, and the entire `visualizer` object, byte-for-byte in value.
- [ ] Keep content props and `captions: null` in Root.
- [ ] Root reads the shared visual defaults.
- [ ] `buildProps` merges those defaults before the trusted clip title and asset filenames.
- [ ] Do not change Main, waveform, caption, font or layout implementations.
- [ ] Label the Studio composition with a `Classic` folder/group from the catalog.
- [ ] Retain `AudiogramBasic`.
- [ ] Check the installed API using Context7 at implementation time.
- [ ] List the Default variation in documentation.
- [ ] Do not add a redundant one-option dropdown.
- [ ] Future variations are separate catalog-backed entries.
- [ ] Update registry tests to compare all expected props.
- [ ] Test that callers cannot change nested defaults.
- [ ] Run `node --test scripts/template-selection.test.mjs scripts/treatment-registry.test.mjs`.
- [ ] Run `npm run lint`.
- [ ] No browser-incompatible imports may enter the bundle.
- [ ] Render the candidate with the Task 1 command and a candidate output filename.
- [ ] Compare parity before proceeding.
- [ ] Commit the catalog/defaults slice only after exact parity passes.

## Task 3: Scope runs, results, failures and manifests to selection

**Files:** `scripts/clip-processing-core.mjs`, `scripts/single-url-pipeline.mjs`, `scripts/treatment-runner.mjs` and their existing tests.

**Interfaces:** Use `runSingleUrlPipeline({url, templateSelection, ...existing})`.
Processing still consumes `treatments: [{id,version}]`.
The runner accepts additive `selection` with `{clipPackage,treatment,selection}` and returns its existing relative MP4 path string.

- [ ] Add a test-only second treatment and pre-existing pending/failed/rendered rows for the same clip.
- [ ] Check that the requested selection renders only its own pending rows.
- [ ] Check that it collects only its artifacts.
- [ ] Check that it ignores unrelated render failures.
- [ ] Retain source/package failures that affect all treatments.
- [ ] Resolve the selection.
- [ ] Check the selection before metadata requests, directory creation, database writes or analysis.
- [ ] Use existing dependency injection points to supply the catalog/resolver in tests.
- [ ] Exercise the second treatment without exposing another production preset.
- [ ] Build a set of requested treatment keys.
- [ ] Apply that set to these operations:

- Execution of pending runs.
- Every `listRenderedArtifacts` call, including failure recovery.
- Aggregation of failed runs.

```js
const requestedKeys = new Set(treatments.map(({id, version}) => `${id}@${version}`));
const isRequested = (run) => requestedKeys.has(`${run.treatmentId}@${run.treatmentVersion}`);
```

For pending execution combine this predicate with the existing video filter.
Keep legacy omitted callers targeting their existing treatment set.
Preserve path containment, realpath/symlink and nonempty-file checks.

- [ ] Add an atomic `clip-N.manifest.json` sidecar.
- [ ] Include `manifestVersion: 1`, canonical selection, treatment ID/version and composition ID.
- [ ] Include the exact resolved props and artifact hash.
- [ ] Write the manifest.
- [ ] Rename the manifest before reporting a new run as successful.
- [ ] A manifest failure must fail the render operation.
- [ ] Do not enqueue a candidate after a manifest failure.
- [ ] Keep the MP4 naming/path and runner return type unchanged.
- [ ] Check passed selection maps to the treatment before writes.
- [ ] Historical valid MP4s do not require retroactive manifests.
- [ ] Test props/manifest content, unchanged path, manifest write failure, empty render, selected missing MP4, and unrelated artifact exclusion.
- [ ] Check that the runner never returns `.partial` output.
- [ ] Check that a manifest failure cannot produce a new success result.
- [ ] Run `node --test scripts/clip-processing-core.test.mjs scripts/single-url-pipeline.test.mjs scripts/treatment-runner.test.mjs scripts/audiogram-ledger.test.mjs`.
- [ ] Commit the scoped processing slice.
- [ ] This task does not require a ledger schema migration.

## Task 4: CLI and playlist adapters

**Files:** `scripts/template-selection-config.mjs`, `scripts/audiogram-url.mjs`, `scripts/youtube-pipeline.mjs`.
`scripts/audiogram-url.test.mjs`, `scripts/template-selection.test.mjs`.

**Interfaces:** `resolveTemplateSelectionConfig({request = {}, environment = {}})` returns `ResolvedTemplateSelection`.
Explicit request fields take precedence over environment fields.
Absent fields use catalog defaults.
Environment names: `AUDIOGRAM_TEMPLATE`, `AUDIOGRAM_TEMPLATE_VERSION`, `AUDIOGRAM_VARIATION`.

- [ ] Test omission, explicit Default, each environment field, explicit-over-environment precedence, and empty/invalid values.
- [ ] Validation must precede mocked fetch/open-ledger calls (assert zero calls).
- [ ] Add the string CLI flags `template`, `template-version` and `variation`.
- [ ] Map those flags to `templateId`, `templateVersion` and `variationId`, respectively.
- [ ] Pass canonical selection to the pipeline.
- [ ] Preserve parser errors on stderr/exit 2, operational JSON failure contracts and URL-only calls.
- [ ] Semantic selection errors use `INVALID_TEMPLATE_SELECTION` in the existing failure envelope.
- [ ] Replace playlist hardcoded treatment lists and logged hardcoded labels with the resolved identity.
- [ ] Resolve before OAuth or metadata requests.
- [ ] Do not put visual choice into `buildSelectionRecipe` or `packageVersion`.
- [ ] Keep `contractVersion: 1` and existing response fields intact.
- [ ] Store identity in sidecars and job data.
- [ ] This does not require a response-version change.
- [ ] Run `node --test scripts/audiogram-url.test.mjs scripts/template-selection.test.mjs scripts/single-url-pipeline.test.mjs`.
- [ ] Check that invocation help includes this example:

```sh
npm run audiogram:url -- --url '<youtube-video-url>' --template classic --template-version 1 --variation default
```

This is a usage example only.
Tests use fake network/renderer dependencies.
Commit the adapters.

## Task 5: Helper job persistence and worker forwarding

**Files:** Plugin server, local-runner, job-store, job-worker and tests listed above.
Read the plugin update skill before implementation changes to the plugin.

**Interfaces:** `runner.start({url,videoId,templateSelection})`.
`jobStore.createOrGetJob({videoId,sourceUrl,selection,renderKey})`.
Omitted selection remains Classic Default.
Job records expose canonical `selection` and `renderKey`.
Old result fields remain intact.

- [ ] Write migration tests against a database with the current jobs schema.
- [ ] Include queued, running, complete and failed records.
- [ ] Open the database twice after migration.
- [ ] Check that IDs, statuses and results remain intact.
- [ ] Check existing columns with `PRAGMA table_info(jobs)`.
- [ ] Use an explicit transaction to add missing columns.
- [ ] Add `render_key TEXT NOT NULL DEFAULT 'audiogram-basic@1'`.
- [ ] Add `selection_json`.
- [ ] Populate existing records with canonical Classic Default values.
- [ ] Preserve `jobs_one_active_video` and its serialization property.
- [ ] Same video plus same selection returns the existing active job.
- [ ] A request for the same video with a different selection returns `VIDEO_BUSY_DIFFERENT_TEMPLATE`.
- [ ] The runner must not start overlapping workers that race shared source assets.
- [ ] Once the active job finishes, the new selection can start.
- [ ] The helper continues to exclude completed jobs from reuse.
- [ ] The pipeline ledger controls render reuse.
- [ ] Use `BEGIN IMMEDIATE` around the lookup and insert.
- [ ] If a uniqueness conflict occurs, cancel the transaction.
- [ ] Read the winning record again.
- [ ] Apply the same match/conflict policy.
- [ ] Test two store connections, same-selection deduplication and different-selection conflict.
- [ ] Test failure leaves no partial migration or orphaned queued row.
- [ ] Add optional MCP input fields for `templateId`, `templateVersion` and `variationId`.
- [ ] Use the shared resolver to check those fields before store writes.
- [ ] Retain URL-only clients and sanitized error handling.
- [ ] Unknown selection and busy conflict must have useful messages without paths/secrets.
- [ ] Forward canonical fields through detached worker argument arrays.
- [ ] The stored job selection is authoritative.
- [ ] The worker reads the stored selection.
- [ ] The worker checks any supplied selection against it.
- [ ] The worker forwards all three flags to the URL CLI.
- [ ] A legacy job with missing fields resolves Classic Default even if process environment selects something else.
- [ ] Retain URL/job-id handling, result validation and terminal-state recovery.

```js
const selectionArgs = ['--template', selection.templateId,
  '--template-version', selection.templateVersion, '--variation', selection.variationId];
// Append to execFile argument arrays; never build a shell string.
```

- [ ] In `job-worker.mjs`, load the job before constructing the default command.
- [ ] Preserve the injected `runCommand` function for tests.
- [ ] Test exact spawned argument arrays and zero spawns for invalid selection.
- [ ] Test migration recovery, dead PID and unknown job.
- [ ] Test malformed stdout and missing completed artifacts.
- [ ] Keep all existing server tests passing.
- [ ] Run `node --test plugins/audiogram-helper/*.test.mjs`.
- [ ] Commit the plugin slice.
- [ ] Do not migrate the user's real database as part of tests.

## Task 6: Final acceptance, documentation and reconciliation

**Files:** Use the feature note, README files, fixture manifest and relevant verification scripts.
Change `package.json` only for a convenience parity command.

- [ ] Document Classic / Default.
- [ ] Document all three selection fields and environment names.
- [ ] Document retained internal identities and active-job conflicts.
- [ ] Document exact instructions for adding a future template.
- [ ] Require a separate composition/schema, catalog mapping, immutable treatment identity, local preview and regression fixture.
- [ ] Do not advertise square or Editorial as available.
- [ ] Run `npm run lint`.
- [ ] Run `npm run build`.
- [ ] Run `npm run test:youtube`.
- [ ] Run `node --test plugins/audiogram-helper/*.test.mjs`.
- [ ] Check test summaries for skipped tests.
- [ ] Report each skipped test explicitly.
- [ ] Do not equate mocks with live network integration.
- [ ] Render a candidate with omitted selection.
- [ ] Render a candidate with explicit Default selection.
- [ ] Use the same fixture, renderer and dependencies for both renders.
- [ ] Compare both candidates against the unchanged baseline.
- [ ] Inspect the contact sheets.
- [ ] Play the clip.
- [ ] Record commands, hashes, metadata and evidence paths in the feature note.
- [ ] Do not claim preservation until you explain and fix each difference.
- [ ] Do not update the baseline automatically.
- [ ] Review the full diff inline.
- [ ] Check compatibility, source-package reuse and selection checks before side effects.
- [ ] Check artifact scope, migration safety and approval/hash boundaries.
- [ ] Preserve unrelated observability work.
- [ ] Report overlaps before editing shared files.
- [ ] Reconcile feature diagrams with actual behavior, including active-job conflict handling.
- [ ] Set only this feature to `status: COMPLETE` and `implementation-reconciled: true` after all acceptance evidence exists.
- [ ] Record intentional deviations explicitly.
- [ ] Run `npm run verify:feature-docs`.
- [ ] Run `git diff --check`.
- [ ] Other unfinished feature notes may block the repository-wide gate.
- [ ] Report their exact paths.
- [ ] Do not change their status.
- [ ] Do not bypass hooks.
- [ ] Commit the final focused slice.
- [ ] Report checkout, branch, HEAD, changed files, test/render evidence and remaining gaps.
- [ ] Prepare the reviewable PR handoff after authorized execution.
- [ ] Do not publish, merge or deploy as part of this plan.

## Plan review and execution handoff

Architecture approval: user requested this implementation plan on 2026-10-04.
Execution method: inline, with focused self-review and no subagents, per repository instructions.
Plan status: ready for human review.
Product implementation did not start.
Square geometry: deferred pending an explicit answer.
Preserve portrait throughout this plan.

All six tasks form one compatibility feature.
Report selection as complete only after the implementation covers the plugin and result paths.