import assert from "node:assert/strict";
import test from "node:test";
import { projectRankedCandidates } from "./jev-projection.mjs";

test("projects only grounded, confident, duration-valid Jev candidates", () => {
  const result = projectRankedCandidates({
    questionId: "main_idea",
    candidates: [
      { candidateId: "good", startMs: 0, endMs: 30_000, title: "Good", summary: "Complete idea" },
      { candidateId: "short", startMs: 0, endMs: 10_000, title: "Short", summary: "Too short" },
      { candidateId: "blocked", startMs: 0, endMs: 40_000, title: "Blocked", summary: "Unsafe" },
    ],
    ranked: [
      { candidateId: "good", score: .9, confidence: .8, reviewRequired: false, blocked: false },
      { candidateId: "short", score: .8, confidence: .9, reviewRequired: false, blocked: false },
      { candidateId: "blocked", score: 0, confidence: .9, reviewRequired: true, blocked: true },
    ],
  });
  assert.deepEqual(result, [{ rank: 1, candidateId: "good", analysisQuestionId: "main_idea", startMs: 0, endMs: 30_000, score: .9, confidence: .8, reviewRequired: false, title: "Good", summary: "Complete idea" }]);
});

test("deduplicates candidate IDs and preserves ranked order", () => {
  const result = projectRankedCandidates({
    questionId: "video_about",
    candidates: [{ candidateId: "a", startMs: 0, endMs: 30_000, title: "A", summary: "A" }],
    ranked: [
      { candidateId: "a", score: .7, confidence: .8, blocked: false },
      { candidateId: "a", score: .6, confidence: .8, blocked: false },
    ],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].analysisQuestionId, "video_about");
});
