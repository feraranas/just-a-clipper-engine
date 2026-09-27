import assert from "node:assert/strict";
import test from "node:test";
import { runQuestionAnalysis } from "./question-analysis-pipeline.mjs";

test("question analysis pipeline sends candidates to Jev and returns ranked output", async () => {
  let judged;
  const result = await runQuestionAnalysis({
    transcript: { cues: [{ id: "c000001", startMs: 0, endMs: 1000, text: "idea" }] },
    recipe: { questions: ["main_idea"] },
    provider: {
      async generateStructured() {
        return { parsed: { candidates: [{ candidateId: "candidate", startCueId: "c000001", endCueId: "c000001", title: "Idea", summary: "Grounded idea" }], answers: [] }, provenance: { providerId: "fixture" } };
      },
    },
    jevClient: {
      async judgeCandidates(request) {
        judged = request;
        return { candidate: { scores: { relevance: 1, insight: 1, selfContainedness: 1 }, nouls: {}, confidence: 0.9 } };
      },
    },
  });
  assert.equal(judged.candidates[0].candidateId, "candidate");
  assert.equal(result.ranked[0].candidateId, "candidate");
});
