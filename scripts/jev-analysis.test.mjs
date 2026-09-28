import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAndRankCandidates, evaluateCandidates, rankCandidates } from "./jev-analysis.mjs";
import { createHttpJevClient, createJevClient } from "./jev-client.mjs";

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

test("HTTP Jev client sends bounded authenticated JSON and returns judgments", async () => {
  let request;
  const client = createHttpJevClient({
    endpoint: "https://typesafe.example/judge",
    apiKey: "secret",
    fetchImpl: async (url, init) => {
      request = { url, init };
      return { ok: true, async json() { return { answers: { candidate: { confidence: 1 } } }; } };
    },
  });
  const judgments = await client.judgeCandidates({ transcript: {}, questions: [], candidates: [] });
  assert.equal(request.url, "https://typesafe.example/judge");
  assert.equal(request.init.headers.authorization, "Bearer secret");
  assert.deepEqual(judgments, { candidate: { confidence: 1 } });
});

test("combined lifecycle returns reusable judgments and ranked candidates", async () => {
  const result = await evaluateAndRankCandidates({
    transcript: { cues: [] },
    questions: [],
    candidates: [{ candidateId: "candidate" }],
    client: createJevClient({
      judgeCandidates: async () => ({
        candidate: {
          scores: { relevance: 1, insight: 1, selfContainedness: 1 },
          nouls: {},
          confidence: 0.9,
        },
      }),
    }),
  });
  assert.equal(result.candidateCount, 1);
  assert.equal(result.judgments.candidate.confidence, 0.9);
  assert.equal(result.ranked[0].candidateId, "candidate");
});
