import assert from "node:assert/strict";
import test from "node:test";

import { rankTranscriptPackagesWithJev } from "./jev-transcript-ranking.mjs";

test("Jev reranks transcript-derived packages and filters blocked candidates", async () => {
  const result = await rankTranscriptPackagesWithJev({
    transcript: { cues: [] },
    packages: [
      { startMs: 0, endMs: 30_000, title: "first" },
      { startMs: 40_000, endMs: 70_000, title: "second" },
    ],
    questions: [{ id: "main_idea" }],
    jevClient: {
      async judgeCandidates({ candidates }) {
        assert.equal(candidates.length, 2);
        return {
          "candidate-1": { scores: { relevance: 1, insight: 1, selfContainedness: 1 }, nouls: {}, confidence: 0.9 },
          "candidate-2": { scores: { relevance: 4, insight: 4, selfContainedness: 4 }, nouls: { containsSponsorOrCta: true }, confidence: 0.99 },
        };
      },
    },
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "first");
  assert.equal(result[0].jevConfidence, 0.9);
});
