# Classic Template Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline. Follow the user's no-subagent policy; review the focused diff yourself. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the current portrait Audiogram as Classic V1 / Default and make its selection explicit throughout rendering and the helper plugin, with verified output parity.

**Architecture:** Add a browser-safe catalog/resolver above the existing treatment registry. Preserve `audiogram-basic@1`, `AudiogramBasic`, existing paths, and clip-package identity. Propagate canonical selection through entry points, active jobs, rendering, manifests, failure reporting, and result collection.

**Tech Stack:** Existing Node ESM and node:test, SQLite, TypeScript/React, Remotion 4.0.525, Zod, FFmpeg/ffprobe. No dependency upgrades or new production dependencies.

**Spec:** `docs/features/classic-template-selection.md`. Read both documents before execution.

## Global Constraints

- Existing composition ID, treatment ID/version and historical paths remain valid.
- Omission and explicit Classic Default have the same treatment, props and output.
- The first implementation exposes only Classic / Default.
- Clip selection and source assets can be reused across visual treatments.
- The first slice introduces no new visual style or publishing capability.
- Preserve 1080x1920 at 30 fps. Square support is not authorized by silence: its unanswered design question remains deferred, without blocking portrait preservation.
- Work inline, no delegated implementer or reviewer. Preserve unrelated files and never reset/clean the checkout.
- Design approval is recorded by the user's instruction to start this plan. Implementation starts after plan review.
- Keep the feature note DESIGN until actual implementation, tests, render comparison and reconciliation succeed.
- Existing source has Remotion 4.0.525 and `node:sqlite`; confirm the installed runtime supports the existing test harness before starting.

## Review Focus

1. Unrelated failed/pending treatments for the same video must not affect the requested result (Task 3).
2. Two concurrent helper requests with different selections must not share a job or race shared asset acquisition (Task 5).
3. Legacy active jobs and completed records must survive repeat migration and reopening (Task 5).
4. Empty, null, unknown and mismatched selection fields must fail before side effects (Tasks 2, 4, 5).
5. Successful historical rows with missing output files must not be returned as success, and missing additive manifests must not invalidate valid legacy MP4s (Tasks 3, 4).

## File responsibilities

| Files | Responsibility |
| --- | --- |
| `src/templates/catalog.mjs`, `catalog.d.mts` (new) | Serializable catalog, canonical resolver, browser-safe public types |
| `src/templates/classic/defaults.json` (new) | Exact existing visual defaults; no content/asset filenames |
| `src/Root.tsx`, `scripts/treatment-registry.mjs` | Consume shared defaults and catalog metadata without renaming identities |
| `scripts/template-selection-config.mjs` (new) | Map explicit request/environment fields into the canonical resolver |
| `scripts/template-selection.test.mjs` (new) | Catalog, default and invalid-selection contracts |
| `scripts/clip-processing-core.mjs` | Execute only requested treatment identities |
| `scripts/single-url-pipeline.mjs` | Resolve early; scope collection and failure aggregation |
| `scripts/treatment-runner.mjs` | Existing render path plus additive identity manifest |
| `scripts/audiogram-url.mjs`, `scripts/youtube-pipeline.mjs` | CLI and playlist selection adapters |
| `plugins/audiogram-helper/{server,local-runner,job-store,job-worker}.mjs` | MCP fields, canonical active-job identity, persisted selection and worker forwarding |
| Existing associated `.test.mjs` files; new `job-store.test.mjs`, `job-worker.test.mjs` | Regression and migration contracts |
| `scripts/verify-classic-parity.mjs`, `.test.mjs` (new) | Compare media metadata, decoded frame/audio hashes and fixture provenance |
| `tests/fixtures/classic-v1/` (new) | Deterministic synthetic inputs, props and baseline manifest; clearly label sample content |
| `README.md`, `plugins/audiogram-helper/README.md`, feature note | User-facing selection, template admission and reconciliation |

## Task 1: Establish a reproducible pre-change baseline

**Files:** Create fixture generator/inputs under `tests/fixtures/classic-v1/`, `scripts/verify-classic-parity.mjs` and its test. No product changes in this task.

**Interfaces:** `verify-classic-parity.mjs --baseline <mp4> --candidate <mp4> --manifest <json>` exits 0 only for matching dimensions, fps, frame count, decoded frame hashes and decoded audio hashes; exits nonzero with the first mismatch. Missing audio on either side fails for this fixture.

- [ ] Verify `pwd -P`, `git rev-parse --show-toplevel`, branch, HEAD and status. Inspect attached worktrees before creating isolation at execution time. Carry only the approved feature note and plan; do not copy unrelated observability documents. Record the exact baseline commit; re-inspect relevant changes if HEAD differs from `195a8f4418ba5eaf47806506b474f4d31d4fcbe1`.
- [ ] Create a deterministic 6-second fixture, using generated PCM audio, a simple locally generated SVG thumbnail visibly marked `SYNTHETIC FIXTURE`, and captions that span multiple pages. Include a long title. Copy assets into a dedicated `public/generated/classic-regression/` directory for rendering and keep generated videos under ignored `out/classic-regression/`.
- [ ] Use 16 kHz mono sine PCM (440 Hz, fixed amplitude), captions with fixed millisecond times and enough words to exercise the actual page-break algorithm. Store the full fixture inputs rather than relying on downloads. Keep the generator deterministic and hash its outputs.
- [ ] Write the fixture props in `tests/fixtures/classic-v1/props.json` using existing prop names and visual defaults from Root. Save hashes of input files, package lock, actual loaded font files, exact commit, browser executable/version and render command in `baseline-manifest.json`. Inspect font-loading behavior and capture font bytes without changing font loading during baseline capture; fail clearly if the same fonts cannot be used for both renders.
- [ ] Before product edits, render the baseline using installed local tools:

```sh
./node_modules/.bin/remotion render AudiogramBasic out/classic-regression/baseline.mp4 --props=tests/fixtures/classic-v1/props.json --frames=0-179 --concurrency=1 --codec=h264
```

Keep the existing JPEG intermediate-frame configuration, codec and all settings identical for the candidate. The inclusive frame range produces 180 frames. Current CLI reference: https://www.remotion.dev/docs/cli/render (verified through Context7 during planning).

- [ ] Implement parity comparison using `execFile` argument arrays, never interpolated shell commands. Use ffprobe JSON and FFmpeg decoded hashes:

```js
const videoArgs = ['-v', 'error', '-i', file, '-map', '0:v:0',
  '-an', '-pix_fmt', 'rgb24', '-f', 'framemd5', '-'];
const audioArgs = ['-v', 'error', '-i', file, '-map', '0:a:0',
  '-vn', '-acodec', 'pcm_s16le', '-f', 'hash', '-hash', 'sha256', '-'];
```

Compare normalized frame records, excluding comment headers; compare decoded audio hashes and audio metadata. Check provenance and reject differences in fixture hashes/settings before attributing differences to the refactor. Export `compareParityRecords(baseline, candidate)` as a pure helper returning `{equal, reason}` for tests.

- [ ] Test equal records, a changed frame, changed audio, missing audio, changed fps/dimensions/frame count and missing input files. Run `node --test scripts/verify-classic-parity.test.mjs`, then compare the baseline to itself and to a deliberately altered local copy to verify the real command fails on mismatch.
- [ ] Save a contact sheet at start, a caption page transition, an active-waveform frame, and the last frame. Inspect it and watch the short video. Stop and explain render/font/runtime failures; never substitute a mock render for this baseline.
- [ ] Commit only the cohesive fixture/checker files and manifest (not private source media or generated MP4s). Retain the baseline video locally throughout execution.

## Task 2: Catalog, resolver and frozen Classic defaults

**Files:** New catalog/type declaration/defaults/config/test files listed above; modify `src/Root.tsx`, `scripts/treatment-registry.mjs`, `scripts/treatment-registry.test.mjs`; enable `resolveJsonModule` in `tsconfig.json` if required for the JSON import.

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

- [ ] Implement a frozen catalog with one entry; omitted fields receive Classic defaults, supplied values are validated without trimming them into a different ID. Validate all catalog treatment mappings against the Node registry in tests. Return fresh canonical data so callers cannot mutate global defaults.
- [ ] Extract only existing visual props: `titleColor`, `captionsTextColor`, `onlyDisplayCurrentSentence`, and the entire `visualizer` object, byte-for-byte in value. Keep content props and `captions: null` in Root. Root reads shared visual defaults; `buildProps` merges them before trusted clip title and asset filenames. Do not change Main, waveform, caption, font or layout implementations.
- [ ] Label the Studio composition through a catalog-derived `Classic` folder/group while retaining `AudiogramBasic`; confirm the installed API using Context7 at implementation time. List the Default variation in documentation; no redundant one-option dropdown is required. Future variations are separate catalog-backed entries.
- [ ] Update registry tests to compare full expected props; test nested default immutability. Run `node --test scripts/template-selection.test.mjs scripts/treatment-registry.test.mjs` and `npm run lint`; no browser-incompatible imports may enter the bundle.
- [ ] Render the candidate with the Task 1 command (candidate output filename) and run parity comparison before proceeding. Commit the catalog/defaults slice only after exact parity passes.

## Task 3: Scope runs, results, failures and manifests to selection

**Files:** `scripts/clip-processing-core.mjs`, `scripts/single-url-pipeline.mjs`, `scripts/treatment-runner.mjs` and their existing tests.

**Interfaces:** `runSingleUrlPipeline({url, templateSelection, ...existing})`; processing still consumes `treatments: [{id,version}]`. The runner accepts additive `selection` with `{clipPackage,treatment,selection}` and returns its existing relative MP4 path string.

- [ ] Add a test-only second treatment and pre-existing pending/failed/rendered rows for the same clip. Assert requested selection renders only its own pending rows, collects only its artifacts, and ignores unrelated render failures. Retain source/package failures that affect all treatments.
- [ ] Resolve and validate before metadata fetch, directories, database writes or analysis. Inject catalog/resolver through existing dependency seams only in tests to exercise the second treatment without exposing a production preset.
- [ ] Build a set of requested treatment keys and apply it to pending-run execution, every `listRenderedArtifacts` call (including catch/recovery), and failed-run aggregation:

```js
const requestedKeys = new Set(treatments.map(({id, version}) => `${id}@${version}`));
const isRequested = (run) => requestedKeys.has(`${run.treatmentId}@${run.treatmentVersion}`);
```

For pending execution combine this predicate with the existing video filter. Keep legacy omitted callers targeting their existing treatment set. Preserve path containment, realpath/symlink and nonempty-file checks.

- [ ] Add an atomic `clip-N.manifest.json` sidecar containing `manifestVersion: 1`, canonical selection, treatment ID/version, composition ID, exact resolved props and artifact hash. Write/rename it before treating a new run as successful; manifest failure fails the render operation without enqueueing a candidate. Keep the MP4 naming/path and runner return type unchanged. Validate passed selection maps to the treatment before writes. Historical valid MP4s do not require retroactive manifests.
- [ ] Test props/manifest content, unchanged path, manifest write failure, empty render, selected missing MP4, and unrelated artifact exclusion. Ensure `.partial` output is never returned and failed manifests cannot pair with a newly reported success.
- [ ] Run `node --test scripts/clip-processing-core.test.mjs scripts/single-url-pipeline.test.mjs scripts/treatment-runner.test.mjs scripts/audiogram-ledger.test.mjs`. Commit the scoped processing slice. No ledger schema migration is needed here.

## Task 4: CLI and playlist adapters

**Files:** `scripts/template-selection-config.mjs`, `scripts/audiogram-url.mjs`, `scripts/youtube-pipeline.mjs`; `scripts/audiogram-url.test.mjs`, `scripts/template-selection.test.mjs`.

**Interfaces:** `resolveTemplateSelectionConfig({request = {}, environment = {}})` returns `ResolvedTemplateSelection`. Explicit fields beat environment fields; absent fields use catalog defaults. Environment names: `AUDIOGRAM_TEMPLATE`, `AUDIOGRAM_TEMPLATE_VERSION`, `AUDIOGRAM_VARIATION`.

- [ ] Test omission, explicit Default, each environment field, explicit-over-environment precedence, and empty/invalid values. Validation must precede mocked fetch/open-ledger calls (assert zero calls).
- [ ] Add string CLI flags `template`, `template-version`, `variation`; map to `templateId`, `templateVersion`, `variationId`. Pass canonical selection to the pipeline. Preserve parser errors on stderr/exit 2, operational JSON failure contracts and URL-only calls. Semantic selection errors use `INVALID_TEMPLATE_SELECTION` in the existing failure envelope.
- [ ] Replace playlist hardcoded treatment lists and logged hardcoded labels with the resolved identity. Resolve before OAuth or metadata requests. Do not put visual choice into `buildSelectionRecipe` or `packageVersion`.
- [ ] Keep `contractVersion: 1` and existing response fields intact; identity is persisted in sidecars/job data rather than requiring a response-version change.
- [ ] Run `node --test scripts/audiogram-url.test.mjs scripts/template-selection.test.mjs scripts/single-url-pipeline.test.mjs`. Verify invocation help documents:

```sh
npm run audiogram:url -- --url '<youtube-video-url>' --template classic --template-version 1 --variation default
```

This is a usage example only; tests use fake network/renderer dependencies. Commit the adapters.

## Task 5: Helper job persistence and worker forwarding

**Files:** Plugin server, local-runner, job-store, job-worker and tests listed above. Read the plugin update skill before implementation changes to the plugin.

**Interfaces:** `runner.start({url,videoId,templateSelection})`; `jobStore.createOrGetJob({videoId,sourceUrl,selection,renderKey})`. Omitted selection remains Classic Default. Job records expose canonical `selection` and `renderKey`; old result fields remain intact.

- [ ] Write migration tests against a database constructed with the current jobs schema: queued, running, complete and failed records. Reopen twice and verify IDs/status/results survive. Add `render_key TEXT NOT NULL DEFAULT 'audiogram-basic@1'` and `selection_json` with canonical Classic Default backfill in an explicit transaction guarded by `PRAGMA table_info(jobs)`.
- [ ] Preserve `jobs_one_active_video` and its serialization property. Same video plus same selection returns the existing active job. Same video plus different selection returns a clear `VIDEO_BUSY_DIFFERENT_TEMPLATE` error; it must not launch overlapping workers that race shared source assets. Once the active job finishes, the new selection can start. Completed jobs continue not to be reused by the helper; render reuse remains the pipeline ledger's responsibility.
- [ ] Use `BEGIN IMMEDIATE` around lookup/insert; on uniqueness contention roll back, reread the winner and apply the same match/conflict policy. Test two store connections, same-selection deduplication and different-selection conflict. Test failure leaves no partial migration or orphaned queued row.
- [ ] Add optional MCP input fields for `templateId`, `templateVersion`, `variationId`, validated by the shared resolver before store writes. Retain URL-only clients and sanitized error handling. Unknown selection and busy conflict must have useful messages without paths/secrets.
- [ ] Forward canonical fields through detached worker argument arrays. Persisted job selection is authoritative: the worker reads it, checks any supplied selection agrees, and forwards all three flags to the URL CLI. A legacy job with missing fields resolves Classic Default even if process environment selects something else. Retain URL/job-id handling, result validation and terminal-state recovery.

```js
const selectionArgs = ['--template', selection.templateId,
  '--template-version', selection.templateVersion, '--variation', selection.variationId];
// Append to execFile argument arrays; never build a shell string.
```

- [ ] In `job-worker.mjs`, move default command construction after loading the job; preserve the injected `runCommand` testing seam. Test exact spawned argument arrays, invalid selection causing zero spawns, migration recovery, dead PID, unknown job, malformed stdout and missing completed artifact. Keep all existing server tests passing.
- [ ] Run `node --test plugins/audiogram-helper/*.test.mjs`. Commit the plugin slice; do not migrate the user's real database as part of tests.

## Task 6: Final acceptance, documentation and reconciliation

**Files:** Feature note, README files, fixture manifest and relevant verification scripts; package.json only if adding a convenience parity command.

- [ ] Document Classic / Default, all three selection fields and environment names, retained internal identities, active-job conflict behavior, and exact instructions for adding a future template. Require a separate composition/schema, catalog mapping, immutable treatment identity, local preview and regression fixture. Do not advertise square or Editorial as available.
- [ ] Run `npm run lint`, `npm run build`, `npm run test:youtube`, and `node --test plugins/audiogram-helper/*.test.mjs`. Check test summaries for skipped tests and report them explicitly; do not equate mocks with live network integration.
- [ ] Render omitted-selection and explicit-Default candidates using the same fixture, renderer and dependency state; compare both against the untouched baseline. Inspect contact sheets and play the clip. Record commands, hashes, metadata and evidence paths in the feature note. Any difference blocks a preservation claim until explained and fixed; no baseline auto-update.
- [ ] Review the full diff inline for compatibility, source-package reuse, selection validation before side effects, artifact scope, migration safety and approval/hash boundaries. Preserve unrelated observability work and report overlaps before editing shared files.
- [ ] Reconcile feature diagrams with actual behavior, including active-job conflict handling. Set only this feature to `status: COMPLETE` and `implementation-reconciled: true` after all acceptance evidence exists. Record intentional deviations explicitly.
- [ ] Run `npm run verify:feature-docs` and `git diff --check`. Other unfinished feature notes may block the repository-wide gate; report their exact paths without modifying their status or bypassing hooks.
- [ ] Commit the final focused slice. Report checkout, branch, HEAD, changed files, test/render evidence and remaining gaps. Prepare the reviewable PR handoff after authorized execution; do not publish, merge or deploy as part of this plan.

## Plan review and execution handoff

Architecture approval: user requested this implementation plan on 2026-10-04.
Execution method: inline, with focused self-review and no subagents, per repository instructions.
Plan status: ready for human review; no product implementation has begun.
Square geometry: deferred pending an explicit answer; preserve portrait throughout this plan.
All six tasks form one compatibility feature: do not advertise selection as complete until the plugin and result paths are covered.
