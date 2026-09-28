export const projectRankedCandidates = ({
  ranked,
  candidates,
  questionId,
  minimumClipMs = 30_000,
  maximumClipMs = 90_000,
  minimumConfidence = 0.6,
}) => {
  if (!Array.isArray(ranked) || !Array.isArray(candidates))
    throw new Error("Ranked candidates and candidates are required");
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const seen = new Set();
  return ranked.flatMap((item, index) => {
    const candidate = byId.get(item.candidateId);
    if (!candidate || item.blocked || item.confidence < minimumConfidence || seen.has(item.candidateId)) return [];
    const startMs = candidate.startMs;
    const endMs = candidate.endMs;
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
    const durationMs = endMs - startMs;
    if (durationMs < minimumClipMs || durationMs > maximumClipMs) return [];
    seen.add(item.candidateId);
    return [{
      rank: index + 1,
      candidateId: item.candidateId,
      analysisQuestionId: questionId,
      startMs,
      endMs,
      score: item.score,
      confidence: item.confidence,
      reviewRequired: item.reviewRequired,
      title: candidate.title,
      summary: candidate.summary,
    }];
  });
};
