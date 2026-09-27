import assert from "node:assert/strict";
import test from "node:test";
import { runQuestionAnalysis } from "./question-analysis-pipeline.mjs";
import { DatabaseSync } from "node:sqlite";
import { getJevEvaluation } from "./jev-ledger.mjs";

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

test("question analysis pipeline persists the exact Jev result when given a ledger", async () => {
  const database = new DatabaseSync(":memory:");
  const result = await runQuestionAnalysis({
    transcript: { cues: [] },
    recipe: { sha256: "recipe-hash", questions: [] },
    provider: { async generateStructured() { return { parsed: { candidates: [], answers: [] }, provenance: { providerId: "fixture" } }; } },
    jevClient: { async judgeCandidates() { throw new Error("must not run without candidates"); } },
    ledger: database,
    analysisId: "analysis-1",
  });
  assert.deepEqual(result.ranked, []);
  assert.equal(getJevEvaluation(database, "analysis-1").recipeSha256, "recipe-hash");
  database.close();
});
