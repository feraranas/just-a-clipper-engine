import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCandidates, rankCandidates } from "./jev-analysis.mjs";
import { createJevClient } from "./jev-client.mjs";

test("ranks candidates deterministically", () => {
  const ranked = rankCandidates({ b: { scores: { relevance: 1, insight: .5, selfContainedness: 1 }, confidence: .8, nouls: {} }, a: { scores: { relevance: 1, insight: .5, selfContainedness: 1 }, confidence: .8, nouls: {} } });
  assert.deepEqual(ranked.map(({ candidateId }) => candidateId), ["a", "b"]);
});
test("Noul gates block unsafe candidates and flag low confidence", () => {
  const ranked = rankCandidates({ clean: { scores: { relevance: 1, insight: 1, selfContainedness: 1 }, confidence: .9, nouls: {} }, sponsor: { scores: { relevance: 1 }, confidence: .9, nouls: { containsSponsorOrCta: true } }, uncertain: { scores: { relevance: .8 }, confidence: .4, nouls: {} } });
  assert.equal(ranked.find((x) => x.candidateId === "sponsor").blocked, true);
  assert.equal(ranked.find((x) => x.candidateId === "uncertain").reviewRequired, true);
});
test("evaluation delegates to the Jev boundary", async () => {
  let request;
  const client = createJevClient({ judgeCandidates: async (value) => { request = value; return { candidate: { scores: {}, nouls: {}, confidence: 1 } }; } });
  const result = await evaluateCandidates({ transcript: {}, questions: [], candidates: [{ candidateId: "candidate" }], client });
  assert.equal(request.candidates[0].candidateId, "candidate");
  assert.equal(result.candidate.confidence, 1);
});
test("evaluation skips Jev when there are no candidates", async () => {
  const client = createJevClient({ judgeCandidates: async () => { throw new Error("must not call"); } });
  assert.deepEqual(await evaluateCandidates({ transcript: {}, questions: [], candidates: [], client }), {});
});
