# Question-Driven Video Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a versioned, transcript-grounded question framework that becomes the default analysis layer while preserving the existing treatment registry.

**Architecture:** Add a question-analysis recipe beside the current selector recipe. The provider returns validated answers and candidate evidence spans; the ledger stores analysis independently from clip packages; a deterministic projection turns approved candidates into existing ClipPackages and treatment runs.

**Tech Stack:** Node.js ESM, SQLite ledger, Zod/JSON Schema validation, ChatGPT OAuth provider, YouTube captions, Remotion treatment registry.

**Spec:** `docs/superpowers/specs/2026-09-20/question-driven-analysis-design.md`

## Global Constraints

- YouTube captions only in V1; no Whisper fallback in this plan.
- `audiogram-basic@1` remains the only V1 treatment.
- Persist transcript and analysis before treatment acquisition.
- Every answer and clip candidate must cite canonical transcript cue IDs.
- Analysis recipe and question IDs must be hashed and versioned.
- No PR6 cross-process lease, retry, scheduler, or recovery work.

---

### Task 1: Define the question-analysis contract

**Files:**
- Create: `scripts/question-analysis-contract.mjs`
- Test: `scripts/question-analysis-contract.test.mjs`

**Interfaces:**
- Produce `QUESTION_ANALYSIS_VERSION`, immutable question definitions, `buildQuestionAnalysisJsonSchema()`, and `buildQuestionAnalysisRecipe(config)`.
- Each answer shape: `{questionId, answer, evidenceCueIds, startMs, endMs, evidenceQuality, epistemicStatus}`.

- [ ] **Step 1: Write failing tests** for stable question IDs, required fields, cue-ID patterns, explicit/inferred status, and recipe hashing.
- [ ] **Step 2: Run** `node --test scripts/question-analysis-contract.test.mjs` and confirm the missing module/API failure.
- [ ] **Step 3: Implement** the frozen definitions and schema with `additionalProperties: false`.
- [ ] **Step 4: Run** the focused test and confirm PASS.
- [ ] **Step 5: Commit** `feat: define question-driven analysis contract`.

### Task 2: Add structured question analysis generation

**Files:**
- Modify: `scripts/transcript-selector.mjs`
- Modify: `scripts/youtube-inbox-pipeline-core.mjs`
- Test: `scripts/youtube-inbox-pipeline-core.test.mjs`

**Interfaces:**
- Add `buildQuestionAnalysisPrompt(transcript, recipe)`.
- Add provider dispatch for `question-analysis` using the existing bounded OAuth/OpenAI providers.
- Return `{analysis, candidates, provenance}` without downloading media.

- [ ] **Step 1: Write failing tests** proving the prompt serializes all cues as untrusted data and that analysis provider failures do not invoke heatmap fallback.
- [ ] **Step 2: Run** the focused pipeline tests and verify failure.
- [ ] **Step 3: Implement** prompt construction, schema validation, and provider dispatch.
- [ ] **Step 4: Run** focused tests and verify PASS.
- [ ] **Step 5: Commit** `feat: generate grounded question analysis`.

### Task 3: Persist analysis independently in SQLite

**Files:**
- Modify: `scripts/audiogram-ledger.mjs`
- Test: `scripts/audiogram-ledger.test.mjs`

**Interfaces:**
- Add `analyses` and `analysis_answers` tables with video/package identity, recipe hash, transcript identity, provenance, answer JSON, and cue references.
- Add `persistQuestionAnalysis()` and `getQuestionAnalysis()`.

- [ ] **Step 1: Write failing migration, round-trip, identity, and rollback tests.**
- [ ] **Step 2: Run** the ledger tests and confirm failure.
- [ ] **Step 3: Implement** schema migration and atomic persistence.
- [ ] **Step 4: Run** all ledger tests and verify PASS.
- [ ] **Step 5: Commit** `feat: persist question analysis provenance`.

### Task 4: Project grounded answers into ClipPackages

**Files:**
- Modify: `scripts/clip-selection-contract.mjs`
- Modify: `scripts/clip-processing-core.mjs`
- Test: `scripts/clip-selection-contract.test.mjs`

**Interfaces:**
- Add deterministic candidate ranking by question purpose, evidence quality, score, and separation.
- Convert only valid 30–90 second spans into existing ClipPackages.
- Preserve question purpose on each package as `analysisQuestionId`.

- [ ] **Step 1: Write failing tests** for candidate ranking, duplicate suppression, duration normalization, and purpose preservation.
- [ ] **Step 2: Run** focused tests and verify failure.
- [ ] **Step 3: Implement** deterministic projection using the existing package invariants.
- [ ] **Step 4: Run** focused and existing selector tests.
- [ ] **Step 5: Commit** `feat: project analysis answers into clip packages`.

### Task 5: Make question analysis the default and preserve fallback mode

**Files:**
- Modify: `scripts/youtube-pipeline-config.mjs`
- Modify: `scripts/youtube-pipeline.mjs`
- Modify: `docs/PROJECT_STATUS.md`
- Test: `scripts/youtube-pipeline-config.test.mjs`

**Interfaces:**
- Default `AUDIOGRAM_CLIP_SELECTOR` to the question-analysis recipe.
- Keep `youtube-heatmap` and the current transcript insight selector explicitly selectable.
- Record selected recipe/version in the ledger and output summary.

- [ ] **Step 1: Write failing config tests** for the new default and explicit legacy selectors.
- [ ] **Step 2: Run** focused config tests and verify failure.
- [ ] **Step 3: Implement** default dispatch and documentation.
- [ ] **Step 4: Run** full unit suite, lint, and typecheck.
- [ ] **Step 5: Commit** `feat: make question analysis the default V1 mode`.

### Task 6: End-to-end fixture and live smoke validation

**Files:**
- Modify: `scripts/clip-selector-smoke.mjs`
- Test: `scripts/clip-selector-smoke.test.mjs`
- Create: `docs/examples/question-analysis.example.json`

- [ ] **Step 1: Add a deterministic fixture** containing transcript, answers, cue IDs, candidate purposes, and expected timestamps.
- [ ] **Step 2: Add smoke assertions** for transcript persistence, analysis persistence, candidate projection, and treatment handoff.
- [ ] **Step 3: Run** `npm test`, `npm run lint`, and the fixture smoke command.
- [ ] **Step 4: Run one bounded live DHH or inbox smoke** only after tests pass; record provider, recipe hash, timestamps, and artifacts.
- [ ] **Step 5: Commit** `test: add question analysis end-to-end fixture`.
