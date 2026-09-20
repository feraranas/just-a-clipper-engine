# Transcript-First Insight Selection Design

Status: approved product direction; not yet implemented

Date: 2026-09-19

## Objective

Turn each saved YouTube video into a short digest of its most valuable,
self-contained ideas for a viewer who has not watched the source.

The default output is three to five clips per video. The pipeline may return
fewer when the transcript does not contain enough strong, distinct ideas. It
must not manufacture filler to meet a quota.

The product is an insight-discovery tool first and a social-video generator
second. A successful clip teaches one recognizable idea without requiring the
viewer to know what the speaker said immediately before it.

## Product problem

YouTube's Most Replayed heatmap measures audience behavior. It can identify a
popular interval, but it cannot determine whether that interval:

- contains an important or novel idea;
- introduces the subject before referring to it;
- completes its explanation or conclusion;
- is understandable outside the source video's narrative;
- adds a distinct insight rather than repeating another selected clip.

The current heatmap-first selector can therefore cut into the middle of an
idea. That is incompatible with the primary user goal: gaining useful insight
from videos that would otherwise remain unwatched.

## Scope

### Included

- Acquire the complete available YouTube caption track without downloading the
  complete video or audio.
- Normalize captions into stable, ordered evidence units.
- Use an LLM to identify and rank insight candidates from the transcript.
- Expand each candidate into a context-complete narrative span.
- Validate duration, transcript continuity, evidence fidelity, and standalone
  coherence before creating a `ClipPackage`.
- Create three to five non-redundant packages when the source supports them.
- Download audio only for accepted intervals.
- Render accepted packages through the existing `audiogram-basic@1` treatment.
- Persist selection provenance so a result can be explained and reproduced.
- Retain the YouTube heatmap as optional evidence and as an explicitly selected
  legacy strategy.

### Excluded

- Local Whisper or bundled model weights. Those remain the V2 transcription
  fallback when YouTube captions are unavailable or inadequate.
- Downloading the full source video or audio.
- Generating synthetic quotes or changing the speaker's meaning.
- Additional Remotion treatments.
- A treatment-selection UI.
- Automatically publishing rendered clips.

## Approaches considered

### 1. Continue heatmap-first selection and add padding

Rejected as the default. Padding can avoid abrupt cuts, but a fixed time window
cannot determine where a premise begins or an argument concludes. Popularity is
also not a reliable proxy for insight value.

### 2. Ask one LLM call to return final timestamps

Rejected. Model-generated timestamps are fragile, difficult to validate, and
can drift from the caption evidence. One large unstructured decision also makes
failures hard to diagnose.

### 3. Transcript-first, evidence-bound selection

Selected. Deterministic code gives each caption or sentence a stable ID. The
model selects evidence IDs and explains its ranking; ordinary code resolves
those IDs to timestamps, expands context, enforces limits, and creates
packages. Long transcripts can be analyzed in sections and reconciled in a
final ranking pass.

This approach keeps probabilistic editorial judgment bounded by source text and
deterministic execution.

## Product output

Each source video produces an insight digest containing zero to five accepted
clips. The target is three to five, but quality is the gate.

Every accepted clip has:

- a concise insight label;
- a short explanation of why the idea is valuable;
- source caption IDs and exact resolved timestamps;
- the verbatim transcript excerpt used as evidence;
- selection and coherence scores;
- selector, prompt, and model provenance;
- a ready `ClipPackage` that treatments can consume.

The initial `audiogram-basic@1` render may use the insight label as its display
title in a later visual-polish increment. The first selector implementation is
not required to change treatment markup.

## Architecture

```text
Saved YouTube video
        |
        v
Full YouTube caption acquisition
        |
        v
Normalized transcript with stable evidence IDs
        |
        v
Semantic sections and candidate generation
        |
        v
Cross-section ranking and de-duplication
        |
        v
Deterministic context-envelope expansion
        |
        v
Standalone-coherence evaluation
        |
        v
Accepted ClipPackages
        |
        +--> partial audio acquisition
        +--> clip-local captions
        +--> thumbnail
        |
        v
audiogram-basic@1 treatment
```

### Video transcript asset

The full normalized transcript belongs to the source video, not to an
individual clip package. It is acquired and normalized once, then reused by
every selector version and every selected interval.

The normalized representation assigns stable, ordered IDs to evidence units.
Each unit contains its source text, start and end timestamps, and caption
provenance. A transcript content hash identifies the exact source evidence used
by a selection run.

V1 keeps the current caption policy:

1. creator-provided YouTube captions;
2. YouTube automatic captions as fallback;
3. an explicit transcript-unavailable result when neither exists.

Whisper is not silently introduced by this feature.

### Selector registry

Selection becomes an explicit, versioned strategy independent of treatments.
The first product selector is `transcript-insight@1`. The current selector is
retained as `heatmap-v1` for comparison, manual fallback, and evaluation.

The default pipeline uses `transcript-insight@1`. A missing heatmap must not
block transcript selection. Heatmap strength may be included as a secondary
ranking feature when available, but it cannot override evidence fidelity or
standalone coherence.

Changing prompt semantics, ranking rules, context-envelope behavior, or model
output interpretation requires a new selector version. Changing only the
Remotion presentation requires a treatment version instead.

### Semantic analysis

The normalized transcript is divided at sentence and topic boundaries while
preserving evidence IDs. Short videos may be evaluated in one pass. Long videos
use a hierarchical flow:

1. identify candidates within bounded transcript sections;
2. compare candidates across the complete video;
3. remove semantic duplicates;
4. rank the remaining candidates for the final digest.

The model returns structured data. It references evidence IDs rather than
inventing timestamps. At minimum, a candidate contains:

```json
{
  "insightLabel": "Why specialization can beat model scale",
  "valueReason": "Explains a useful trade-off between scope and capability",
  "startEvidenceId": "e-0142",
  "endEvidenceId": "e-0157",
  "scores": {
    "insightfulness": 0.91,
    "standaloneCoherence": 0.86,
    "novelty": 0.81,
    "actionability": 0.74
  }
}
```

The schema is necessary but not sufficient. All referenced IDs must exist, be
ordered, and resolve to a continuous transcript interval.

### Ranking rubric

The selector prioritizes:

1. **Insightfulness**: the span contains a meaningful claim, explanation,
   mental model, example, or consequence.
2. **Standalone coherence**: a first-time viewer can identify the subject,
   premise, and conclusion.
3. **Evidence fidelity**: the label and rationale are supported by the selected
   transcript and do not change the speaker's meaning.
4. **Novelty within the digest**: the clip adds an idea not already covered by
   a higher-ranked selection.
5. **Actionability or explanatory value**: the viewer learns something usable
   or gains a clearer model of the topic.

Heatmap popularity is optional secondary evidence. It is never a substitute for
the five product criteria.

### Context envelope

The candidate's evidence span identifies the core insight, not necessarily the
final clip boundary. Deterministic code expands the interval along transcript
boundaries:

- backward until the subject and required premise are introduced;
- forward until the explanation, example, or conclusion completes;
- never into the middle of a caption sentence;
- never across a detected topic boundary merely to reach a target duration.

The preferred clip duration is 30 to 75 seconds. The hard maximum is 90
seconds. A shorter clip is permitted when it is complete. A candidate requiring
more than 90 seconds to become coherent is rejected rather than cut arbitrarily.

### Coherence gate

After expansion, a focused evaluator receives only the proposed excerpt plus
its label and rationale. It judges whether an unfamiliar viewer can understand
the main idea without earlier material.

The gate rejects excerpts that:

- begin with unresolved pronouns or references;
- depend on a definition or example omitted from the span;
- start or finish mid-thought;
- make the label stronger or materially different from the source;
- duplicate an already accepted insight.

The evaluator returns a structured verdict and reasons. Code validates the
verdict and owns the accept/reject transition.

## ClipPackage integration

Accepted intervals become ordinary versioned `ClipPackage` records. The
existing package/treatment boundary remains intact: selection decides what the
clip contains; acquisition supplies its assets; a treatment decides how it is
presented.

A transcript-selected package records at least:

- selector ID and version;
- transcript content hash and caption provenance;
- prompt or rubric version;
- model/provider identifier;
- selected evidence-ID range;
- resolved source timestamps;
- insight label and value reason;
- ranking and coherence results;
- optional heatmap overlap/score;
- stable fingerprint of the selection inputs.

Re-running with the same transcript hash, selector version, model configuration,
and selection settings reuses the completed selection. A changed selector
version creates new packages without invalidating prior packages or treatment
runs.

## Failure behavior

- **No YouTube captions:** record `transcript_unavailable`; create no
  transcript-selected packages. V2 may retry through Whisper.
- **Malformed or empty transcript:** record a validation failure; do not call
  the model.
- **Model/API unavailable:** retain a retryable selection failure. Do not
  silently substitute heatmap selection.
- **Invalid structured response:** retain bounded diagnostics and fail the
  selection run. Never guess missing IDs or timestamps.
- **Too few qualifying insights:** publish the qualifying subset, including
  zero. Do not lower the coherence threshold to reach five.
- **One candidate fails acquisition or rendering:** isolate that package and
  continue processing the other accepted candidates.

`heatmap-v1` remains available only when explicitly requested. This keeps
fallback behavior visible and makes comparisons meaningful.

## Persistence boundaries

The implementation should preserve these concepts even if exact table names are
refined during planning:

- one source transcript record per video, caption provenance, and content hash;
- one immutable normalized transcript artifact per content hash;
- one selection run per selector version and complete input fingerprint;
- multiple candidate decisions per selection run;
- zero to five accepted candidates linked to created `ClipPackage` records;
- independent treatment runs for each package.

Raw model responses may be retained as bounded diagnostic artifacts, but the
ledger stores normalized decisions rather than treating raw prose as state.

## Testing and evaluation

### Deterministic tests

- caption normalization produces stable IDs and hashes;
- selected IDs resolve to ordered, continuous timestamps;
- unknown, reversed, or non-contiguous IDs are rejected;
- context expansion respects sentence/topic boundaries and the 90-second cap;
- duplicate candidates do not produce duplicate packages;
- package and selection fingerprints are idempotent;
- missing heatmap does not block transcript selection;
- invalid model output creates no packages;
- only accepted intervals are passed to partial audio acquisition.

Model calls are replaced with recorded structured fixtures in the normal test
suite. CI must not require YouTube, OAuth, or a live model provider.

### Product-quality evaluation

Before making `transcript-insight@1` the operational default, evaluate it on a
small, diverse set of real saved videos. A human reviewer scores each proposed
clip from one to five for:

- standalone clarity;
- insight value;
- fidelity to the speaker;
- boundary quality;
- non-redundancy within the digest.

The initial acceptance target is a median of at least four for standalone
clarity, insight value, and fidelity, with no accepted clip that materially
misrepresents the source. Failures and rejected candidates remain inspectable so
the rubric can improve without hiding selection mistakes.

The heatmap selector is retained as a baseline during this evaluation. The
comparison asks whether transcript selection produces more useful and coherent
insights, not whether its clips correspond to the most replayed intervals.

## Delivery position

This is a V1 product-selection milestone, not the V2 Whisper milestone. It can
use the existing YouTube-captions-only policy and preserve partial media
acquisition.

Implementation should begin after the first persistence-correctness
stabilization increment because selection provenance and package versions must
not overwrite one another. Recovery, fixtures, and operational readiness should
then include the new selector rather than assuming heatmap-only package jobs.

## Success criteria

- A video with usable YouTube captions can yield up to five distinct,
  evidence-backed insight packages without a heatmap.
- Every accepted package resolves from real caption IDs to exact source
  timestamps.
- A first-time viewer can understand each accepted clip without watching the
  preceding source material.
- The pipeline downloads only accepted audio intervals, never the full video or
  full audio.
- Re-running identical inputs performs no repeated model analysis, acquisition,
  or rendering.
- Changing selector semantics preserves earlier packages and artifacts.
- Missing captions, invalid model output, and low-quality candidates are
  explicit inspectable outcomes rather than silent fallbacks.
- `audiogram-basic@1` remains the only required V1 treatment.
