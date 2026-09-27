const scoreValue = (judgment, dimension) => Number.isFinite(judgment?.scores?.[dimension]) ? judgment.scores[dimension] : 0;

export const rankCandidates = (judgments, weights = {}) => {
  if (!judgments || typeof judgments !== "object") throw new Error("Jev judgments are required");
  const rw = weights.relevance ?? 0.45, iw = weights.insight ?? 0.35, sw = weights.selfContainedness ?? 0.2;
  const total = rw + iw + sw;
  if (!(total > 0)) throw new Error("Jev ranking weights must be positive");
  return Object.entries(judgments).map(([candidateId, judgment]) => {
    const blocked = judgment?.nouls?.containsSponsorOrCta === true || judgment?.nouls?.completeThought === false || judgment?.nouls?.citationSupported === false;
    const score = blocked ? 0 : (rw * scoreValue(judgment, "relevance") + iw * scoreValue(judgment, "insight") + sw * scoreValue(judgment, "selfContainedness")) / total;
    const confidence = Number.isFinite(judgment?.confidence) ? judgment.confidence : 0;
    return { candidateId, score, confidence, reviewRequired: blocked || confidence < 0.6, blocked };
  }).sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.candidateId.localeCompare(b.candidateId));
};

export const evaluateCandidates = async ({ transcript, questions, candidates, client }) => {
  if (!client || typeof client.judgeCandidates !== "function") throw new Error("Jev client is required");
  if (!Array.isArray(candidates) || candidates.length === 0) return {};
  const judgments = await client.judgeCandidates({ transcript, questions, candidates });
  if (!judgments || typeof judgments !== "object") throw new Error("Jev client returned invalid judgments");
  return judgments;
};

export const evaluateAndRankCandidates = async ({
  transcript,
  questions,
  candidates,
  client,
  weights,
}) => {
  const judgments = await evaluateCandidates({ transcript, questions, candidates, client });
  return {
    judgments,
    ranked: rankCandidates(judgments, weights),
    candidateCount: candidates.length,
  };
};
