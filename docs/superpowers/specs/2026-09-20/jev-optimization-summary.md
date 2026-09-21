# Jev Optimization Summary

Jev is a strong fit for the evidence-selection layer, but not a complete replacement for the LLM.

- LLM: generates summaries, candidate interpretations, titles, and possible evidence spans.
- Jev: evaluates structured state and makes fast typed Choice, Score, or Noul judgments with probabilities.
- Code: combines those judgments, applies duration/separation rules, and selects/renders clips.

Recommended pipeline:

```text
YouTube captions → deterministic candidate spans → Jev evaluation → code ranking → optional LLM polish → Remotion artifacts
```

Jev evaluates the video-about, main-idea, secondary-idea, evidence, example, takeaway, and surprise questions; setup, completeness, insight, sponsor content, citation support, and confidence. Use Choice for purpose, Score for graded qualities, and Noul for binary gates.

This enables selectable analysis lenses, confidence-filtered ranking, evidence-quality indicators, low-cost reranking, citation verification, cached judgments, and reusing one transcript across many user views. The LLM remains responsible for candidate generation and polished language; Jev becomes the default evaluator/reranker; deterministic code owns duration, evidence containment, spacing, deduplication, and treatment dispatch.

References: [System One](https://docs.typesafe.ai/concepts/system-one), [State](https://docs.typesafe.ai/concepts/state), [Re-ranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe), [Composite scoring](https://docs.typesafe.ai/patterns/composite-scoring), [Citation checking](https://docs.typesafe.ai/cookbooks/citation_check).
