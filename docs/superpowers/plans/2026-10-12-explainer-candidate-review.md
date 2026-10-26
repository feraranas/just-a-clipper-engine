# Explainer Candidate Review Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Execute inline with no subagents. Steps use checkboxes to record progress.

**Goal:** Prepare source-supported ideas from one YouTube video and save the user's explicit selection through MCP.

**Architecture:** Reuse the existing processing program and saved progress where their interfaces fit. Add the missing topic-review and selection behavior. A separate database or program requires a demonstrated gap. Stop after the user chooses a topic.

**Terminology:** See [the plain-language index](../../explainer-plan-glossary.md) for acronyms and terms used below.

**Tech Stack:** Existing Node.js, SQLite, Zod, MCP SDK, configured LLM provider, Jev, and yt-dlp. No new dependencies are required by this plan.

**Spec:** `docs/features/animated-explainer.md` and `docs/investigations/remotion-explainer-capabilities.md`.

## Plan status and reuse correction

Status: REQUIRES REVISION BEFORE IMPLEMENTATION. No tasks are implemented.
The user clarified that selected topics need research beyond the source video.
This implementation part still ends at explicit topic selection. Research and explanation
 development follow in a separately reviewed plan before script generation.

The new-module map and tasks below are provisional, not an approved build list.
First trace the existing calling code, processing program, saved records, and review interfaces.
Reuse `runQuestionAnalysis` from `scripts/question-analysis-pipeline.mjs` where
its candidate drafting, Jev judgment, ranking, and saved-record interfaces fit.
Reuse transcript extraction, `jev-analysis.mjs`, `jev-ledger.mjs`, and the
existing processing helper. Do not introduce a replacement MCP flow by default.

Record each requirement as existing, needs extension, or missing.
Check how candidate evidence already reaches the code calling the operation and where human
selection can pause the existing flow. Inspect provider recipe compatibility.
Only then replace the provisional file map with the minimal required changes.
A new progress database, processing program, or provider adapter requires a specific contract gap.
Do not start the old tasks until this existing-code check and revised plan are reviewed.

## Global Constraints

- The production sequence never selects a candidate on behalf of the user.
- Every source passage reference identifies an exact transcript revision.
- Use the explicitly configured LLM provider. Require Jev configuration for this implementation part.
- Missing provider configuration fails before source or paid operations begin.
- Do not generate narration, render a video, or enqueue publication in this implementation part.
- Preserve existing Classic tools and template discovery. Do not advertise an unimplemented explainer renderer.
- Save records that define the accepted result in the permanent storage folder, outside removable checkouts.
- Treat transcript and model content as data rather than processing program instructions.
- Preserve unrelated edits, including current template-sample-server work.
- Create or reuse an approved isolated implementation branch at execution time.

## Review Focus

- Missing English captions produces an clear transcript-extraction error.
- Cited passages from separate regions all reach Jev without silent truncation.
- Repeated or concurrent mutations do not launch duplicate paid attempts.
- A processing program crash after sending a request preserves an unconfirmed completion rather than retrying automatically.
- A stale candidate-set revision cannot authorize selection from a newer set.

## Implementation part feature note

Before code, create `docs/features/explainer-candidate-review.md` in DESIGN mode.
Document this implementation part's states and boundaries. Link the overall explainer design.
Selecting a candidate records the decision only in this implementation part. It does not claim
script generation ran. Return `candidate_selected` with script production unavailable.
Keep the overall explainer note DESIGN until broader implementation begins.
Reconcile the implementation part note after its tests. Declare the implementation part note in its implementation PR.

## File map

| File | Responsibility |
|---|---|
| `scripts/explainer/contracts.mjs` | Strict source, candidate, selection, and public-result schemas |
| `scripts/explainer/source.mjs` | Extract and identify timestamped evidence |
| `scripts/explainer/candidates.mjs` | Draft ideas and check citations |
| `scripts/explainer/generation-provider.mjs` | Candidate-specific recipe and existing provider transport integration |
| `scripts/explainer/judgment.mjs` | Build Jev evidence and normalize judgments |
| `scripts/explainer/store.mjs` | SQLite state, revisions, temporary processing locks, requests, attempts, and selections |
| `scripts/explainer/worker.mjs` | Execute source, draft, and judgment stages with saved step results |
| `scripts/explainer/run.mjs` | One-run CLI and safe dependency/configuration setup |
| `plugins/audiogram-helper/explainer-tools.mjs` | Register creation, status, selection, and retry tools |
| `plugins/audiogram-helper/server.mjs` | Connect optional explainer services without changing Classic contracts |
| `scripts/storage-config.mjs` | Add shared explainerDb path and explicit override |
| `scripts/explainer/*.test.mjs` | Focused unit and integration checks |
| `plugins/audiogram-helper/explainer-tools.test.mjs` | Tool contract checks |

Proposed paths become implementation paths only when execution starts.

## Shared contracts

Use string UUIDs to identify video requests and individual tool calls. Use integer saved-progress revisions.
Hashes use the existing canonical JSON hash utility and its existing format.
Store transcript source/language/cues unchanged with the returned identity.
Use transcript hash as sourceRevision. Passage IDs are cue IDs within that revision.

Candidate: candidateId, title, explanation, takeaway, audience,
passageIds, qualifications, visualOpportunities, durationRangeSeconds.
Reject unknown keys, duplicate IDs, empty citations, invalid references,
blank text, and nonpositive or reversed duration ranges.
Limit a set to five candidates. Allow zero and report `no_candidates`.
Each string has an explicit schema length bound. Match prompt and output limits.
Never fabricate a supporting passage to satisfy a count.

Public status: contractVersion, jobId, revision, state, currentStage,
sourceRevision, candidateSetRevision, candidates, selection, allowedActions,
and safe error. Do not return credentials, raw provider logs, or internal paths.
Return passage text and timestamp links alongside candidate citations.
Use `no_candidates`, `awaiting_candidate_selection`, and `candidate_selected`
as successful review outcomes, not as completed video outcomes.

States: queued, extracting_source, drafting_candidates, judging_candidates,
awaiting_candidate_selection, candidate_selected, no_candidates, failed, unknown.
Production steps: source extraction, candidate drafting, and candidate judgment. Store each production step's accepted input hashes.

### Task 1: Contracts and source evidence

**Files:** Create contracts/source modules and their tests.
**Interface:** `extractSource({url, fetchTranscript}) -> SourceRecord`.
Use `fetchYoutubeTranscript(url, {runCommand, tempRoot})` as the production dependency.

- [ ] Write failing tests for stable cue references, malformed timestamps, duplicate cue IDs, missing English captions, and transcript limits.
- [ ] Run `node --test scripts/explainer/source.test.mjs scripts/explainer/contracts.test.mjs` and observe failure before implementation.
- [ ] Implement strict schemas and the source adapter. Reject invalid URLs with the existing URL policy. Do not call the clipping production sequence.
- [ ] Preserve source identity and create passage links with integer start seconds.
- [ ] Rerun the focused tests. Check source failures never start model generation.
- [ ] Commit only the implementation part files and its feature note.

Example acceptance assertion:

```js
assert.equal(source.passages[0].id, source.transcript.cues[0].id);
assert.equal(source.sourceRevision, source.transcript.sha256);
```

The existing transcript identity exposes sha256. Preserve that representation.

### Task 2: Progress database and topic selection

**Files:** Create store and tests. Modify storage config and its tests.
**Interfaces:** `createExplainerStore({dbPath, revisionRoot})` returns
`createJob`, `getJob`, `claimStage`, `saveStage`, `recordSelection`,
`recordFailure`, `recordUnknown`, `requestRetry`, and `close`.
Every mutation accepts jobId, expectedRevision, requestId, and payload.

- [ ] Write failing tests for restart recovery, stale revisions, conflicting request IDs, concurrent processing locks, and selection from another set.
- [ ] Use SQLite transactions for compare-and-swap revisions and request deduplication.
- [ ] Store video requests, execution attempts, tool calls, revision references, and selection decisions in separate tables.
- [ ] Write immutable revision files atomically, check hashes, then commit references. Define orphan-file recovery without deleting unrelated data.
- [ ] Add `AUDIOGRAM_EXPLAINER_DB_PATH`, defaulting to dataRoot/explainers.sqlite.
- [ ] Implement temporary processing locks with owner IDs. Save the attempt record before sending an external request. Attempts with expired processing locks after request dispatch become unknown.
- [ ] Run focused store tests and storage configuration regression tests. Commit.

Acceptance assertions: repeated identical selection returns the original saved result;
conflicting payload with the same requestId fails; a closed/reopened store retains
candidate evidence and selection. A second temporary processing lock owner cannot commit work assigned to the first owner.

### Task 3: Draft candidates and judge evidence

**Files:** Create candidates/judgment/generation-provider modules and tests.
**Interfaces:** `draftCandidates({source, generator}) -> CandidateDraft[]`;
`judgeCandidates({source, candidates, jevClient}) -> CandidateSet`.
The candidate adapter exposes `generateStructured` with instructions, canonical
input, JSON schema, and cancellation signal. The current provider is locked
to the clip-selection recipe's instruction and schema hashes. It cannot accept
the candidate recipe unchanged. Add a dedicated candidate recipe and adapter.
Reuse checked authentication and bounded transport utilities, not the clip
recipe. Do not remove the existing recipe checks to make this work.

- [ ] Write failing tests for unsupported citations, prompt-injection transcript text, empty sets, duplicate ideas, invalid model responses, and distant cited passages.
- [ ] Draft candidates with source data isolated from trusted instructions. Include revision identity in the prompt and validate the response.
- [ ] Add candidate-specific prompt/schema hashes, explicit configured provider, output bounds, timeout, and response parsing. Test recipe mismatch rejection and existing clip-provider behavior.
- [ ] Use Jev for relevance, explanatory value, and source-support judgments. Save judgment provenance and raw bounded structured answers privately.
- [ ] Build evidence from the union of all cited cues and bounded neighboring context. Validate that every cited cue survives projection.
- [ ] For the existing HTTP transport, omit candidate time windows when passing an already bounded evidence projection. Check its current fallback behavior with an injected fetch test.
- [ ] Reject excessive projected evidence explicitly instead of silently dropping passages.
- [ ] Validate complete judgment IDs and finite scores. Block unsupported candidates; show uncertain candidates with review flags. Ordering is a recommendation, never selection.
- [ ] Run focused tests with fake providers. Verify zero paid calls. Commit.

Acceptance: a candidate citing cues near the beginning and end of a video retains
both in the actual injected Jev request. No selection exists after ranking.

### Task 4: Program that runs and saves a step

**Files:** Create processing program/run modules and tests.
**Interface:** `runExplainerStage({jobId, store, sourceAdapter, generator, jevClient}) -> PublicStatus`.
CLI accepts an existing video request ID. It locks and executes exactly one eligible production step.

- [ ] Write failing tests for missing configuration, continuing from a saved step result, cancellation, provider timeout after sending the request, and storage failure.
- [ ] Validate configured provider and Jev credentials before sending a request. Reuse existing credential-location checks. Never log credential values.
- [ ] Execute source, drafting, and judgment as separately execution attempts with saved results.
- [ ] Save verified results before reporting success. Never start rendering or publishing.
- [ ] Save external requests with unconfirmed completion without blind retry. Safe before the request is sent failures become failed and expose an explicit retry action.
- [ ] Add one-run CLI tests that resume completed dependencies without repeating generation.
- [ ] Run focused tests. Commit.

### Task 5: MCP candidate review

**Files:** Create explainer-tools module/tests. Modify server and helper README.
**Interfaces:** register `prepare_explainer`, `get_explainer_status`,
`select_explainer_candidate`, and `retry_explainer_stage`.
Prepare requires url and requestId. Selection requires jobId, expectedRevision,
requestId, candidateSetRevision, and candidateId. Retry names a failed production step.

- [ ] Write failing tool tests for schemas, public evidence output, stale selection, duplicate prepare, missing job, and unconfirmed completions.
- [ ] Register strict input/output schemas. Keep Classic output schemas unchanged.
- [ ] Connect a local process launcher that runs one eligible production step per invocation and schedules the next preparation step after the current step completes. Never hold a processing program open during user review.
- [ ] Return source passages, timestamp links, qualifications, judgments, and allowed actions through structured content.
- [ ] Save selection and stop at candidate_selected. State explicitly that scripts are not generated by this implementation part.
- [ ] Require explicit user retry for uncertain or failed paid requests. Do not interpret status inspection as retry approval.
- [ ] Verify existing Classic/discovery tool tests and new explainer tool tests. Commit.

### Task 6: Integration, live trial, and reconciliation

**Files:** Integration tests, implementation part feature note, helper README, and package scripts.

- [ ] Add restart integration: prepare with fake providers, close the store/server, reopen, inspect candidates, select one, and inspect the saved decision.
- [ ] Add cross-checkout integration: remove a disposable producer directory and retrieve saved passages from shared storage.
- [ ] Add `test:explainer` for the focused suite. Run it and existing helper tests.
- [ ] Run lint/type checks when shared source changes require them. Run `npm run verify:feature-docs`.
- [ ] Run one configured real-source trial only after safe credential preflight. Record provider and any known cost before sending a request. Report unavailable credentials as a live-verification gap.
- [ ] Present actual candidate ideas for user selection. Do not select a trial candidate on the user's behalf.
- [ ] Reconcile the implementation part feature note against code/tests. Mark COMPLETE only after the implemented scope matches its acceptance checks.
- [ ] Keep unfinished implementation in draft. Do not claim live verification from fake-provider tests.

## Completion boundary

This implementation part is usable when MCP can prepare reviewable candidates, preserve their
evidence across restart, and record a valid explicit selection. No video output
is promised. A live trial can remain awaiting user selection while deterministic
selection tests prove the transition. Report that distinction clearly.

## Plan review and execution

This plan records the intended implementation part, but its implementation breakdown requires the existing-code check.
Execution method remains inline, following repository policy.
No product implementation started while writing this plan.
