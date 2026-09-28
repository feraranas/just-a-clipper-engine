import assert from "node:assert/strict";
import test from "node:test";
import { runQuestionAnalysis } from "./question-analysis-pipeline.mjs";
import { renderProjectedPackages } from "./jev-treatment-handoff.mjs";

test("DHH-style fixture flows from transcript through Jev to treatment artifact", async () => {
  const result = await runQuestionAnalysis({
    transcript: {
      source: "youtube_creator",
      language: "en",
      cues: [{ id: "c000001", startMs: 0, endMs: 30_000, text: "The main idea is a simpler operating system." }],
    },
    recipe: { sha256: "fixture-recipe", questions: ["main_idea"] },
    questionId: "main_idea",
    provider: {
      async generateStructured() {
        return {
          parsed: { candidates: [{ candidateId: "candidate-main", startMs: 0, endMs: 30_000, title: "Main idea", summary: "A simpler operating system" }], answers: [] },
          provenance: { providerId: "fixture", model: "fixture" },
        };
      },
    },
    jevClient: {
      async judgeCandidates() {
        return { "candidate-main": { scores: { relevance: 1, insight: .8, selfContainedness: 1 }, nouls: {}, confidence: .95 } };
      },
    },
  });
  const rendered = await renderProjectedPackages({
    packages: result.packages,
    videoId: "MWvH7BRgwL8",
    packageVersion: "question-analysis-v1",
    assets: [],
    treatment: { id: "audiogram-basic", version: "1" },
    render: async ({ clipPackage }) => `out/treatments/audiogram-basic/1/${clipPackage.videoId}/question-analysis-v1/clip-${clipPackage.rank}.mp4`,
  });
  assert.equal(rendered.length, 1);
  assert.match(rendered[0].artifactRelativePath, /MWvH7BRgwL8/);
  assert.equal(rendered[0].analysisQuestionId, "main_idea");
});
