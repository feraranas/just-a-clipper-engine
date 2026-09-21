# Question-Driven Video Analysis Design

## Goal

Make structured editorial analysis the default V1 analysis mode, while keeping Remotion treatment rendering separate from analysis.

## Product model

Every processed video produces two layers:

1. `analysis.json`: answers a stable framework of questions using grounded transcript cue IDs and timestamps.
2. Treatment artifacts: Remotion clips selected from those answers, each labeled with its purpose.

The existing “best insights” selector remains available as a fallback recipe, but is no longer the default.

Jev is the default evaluator/reranker for candidate evidence. The LLM may propose candidate spans and polished language, while Jev supplies typed relevance, purpose, completeness, insight, and evidence-support judgments. Deterministic code owns duration, containment, separation, deduplication, and treatment dispatch.

## Question framework

The default recipe asks:

- What is this video about?
- What is the main idea?
- What are the important secondary ideas?
- What problem, tension, or question is being discussed?
- What evidence, example, or story supports the main idea?
- What is surprising or non-obvious?
- What are the practical implications?
- What conclusion or recommendation does the speaker reach?
- Which transcript spans best support each answer?
- Which 2–3 spans are the most self-contained clips?

Each answer must include grounded cue IDs, a timestamp interval, an evidence-quality label, and whether it is explicit or inferred. Unsupported answers are omitted rather than fabricated.

## Data flow

YouTube captions → canonical transcript ledger → structured question analysis → grounded clip candidates → ClipPackage records → treatment registry → Remotion artifacts.

Analysis is persisted independently from clip selection so a valid transcript and useful answers survive a failed treatment or invalid candidate span.

## Compatibility and constraints

- V1 continues to use YouTube captions only; local Whisper remains a V2 fallback.
- `audiogram-basic@1` remains the only V1 treatment.
- Existing ledger provenance and package-version rules remain immutable.
- Analysis question IDs and recipe hashes are versioned so reruns remain reproducible.
- PR6 cross-process recovery infrastructure is explicitly out of scope for this design.
