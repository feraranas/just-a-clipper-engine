# Jev lifecycle feature flows

## 1. Client boundary

```mermaid
flowchart LR
  App[Application] --> Factory[createJevClient]
  Factory --> Boundary[judgeCandidates boundary]
  Boundary --> Transport[TypeSafe transport]
  Transport --> Judgments[Typed judgments + confidence]
  Judgments --> App
```

The client boundary keeps credentials and provider transport out of ranking code.

## 2. Candidate evaluation

```mermaid
flowchart TD
  Transcript[Timestamped transcript] --> Evaluate[evaluateCandidates]
  Questions[Question framework] --> Evaluate
  Candidates[LLM proposed evidence candidates] --> Evaluate
  Client[Jev client] --> Evaluate
  Evaluate --> Judgments[Judgments keyed by candidate ID]
```

Jev receives transcript state, questions, and candidate spans; this layer does not send audio or video.

## 3. Deterministic ranking and safety gates

```mermaid
flowchart TD
  Judgments --> Scores[Weighted Score dimensions]
  Judgments --> Gates[Noul gates]
  Gates -->|Sponsor CTA incomplete or unsupported| Block[Blocked candidate]
  Scores --> Composite[Composite score]
  Composite --> Sort[Score confidence candidate ID]
  Block --> Sort
  Sort --> Ranked[Deterministic ranked candidates]
  Ranked --> Review[Review flag when blocked or confidence below 0.6]
```

Default weights: relevance 0.45, insight 0.35, self-containedness 0.20. Blocked candidates receive score 0.

## 4. Composed lifecycle

```mermaid
flowchart LR
  Input[Transcript questions candidates] --> Evaluate[evaluateCandidates]
  Evaluate --> Judgments[Reusable raw judgments]
  Judgments --> Rank[rankCandidates]
  Rank --> Result[evaluateAndRankCandidates]
  Result --> Persist[Future ledger provenance]
  Result --> Project[Future ClipPackage projection]
```

The composed operation returns raw judgments and ranked candidates so policy or display changes can reuse judgments without rerunning Jev.

## 5. Injectable HTTP transport

```mermaid
sequenceDiagram
  Pipeline->>JevClient: judgeCandidates(state)
  JevClient->>HTTPS: POST transcript, questions, candidates
  HTTPS-->>JevClient: judgments object
  JevClient-->>Pipeline: validated judgments
```

The HTTP adapter requires an HTTPS endpoint and explicit API key, uses an abort timeout, sends JSON only, and validates that the response contains a judgments object. Tests inject `fetchImpl`; production code supplies the real transport without coupling ranking logic to HTTP.

## 6. Question-analysis adapter

```mermaid
flowchart TD
  Transcript[Timestamped transcript] --> Provider[Question analysis provider]
  Recipe[Question recipe] --> Provider
  Provider --> Candidates[Grounded candidate spans]
  Candidates --> Jev[Jev evaluation]
  Jev --> Result[Raw judgments + ranked candidates]
```

`runQuestionAnalysis()` owns the handoff from structured candidate generation to Jev. It returns provider provenance together with the reusable judgments and ranked output.

## 7. ClipPackage projection

```mermaid
flowchart TD
  Ranked[Ranked candidates] --> Validate[Grounding, confidence, safety, duration]
  Validate -->|blocked, low confidence, invalid span| Reject[Reject or review]
  Validate -->|valid 30-90s span| Package[ClipPackage-shaped output]
  Package --> Treatment[Future Remotion treatment]
```

Projection preserves `analysisQuestionId`, timestamps, score, confidence, review state, title, and summary. Duplicate candidate IDs are suppressed and invalid or unsafe candidates never reach treatment.
