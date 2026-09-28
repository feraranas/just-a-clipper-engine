import { evaluateAndRankCandidates } from "./jev-analysis.mjs";

export const rankTranscriptPackagesWithJev = async ({
  transcript,
  packages,
  questions,
  jevClient,
}) => {
  if (!Array.isArray(packages) || packages.length === 0) return [];
  const candidates = packages.map((clip, index) => ({
    candidateId: `candidate-${index + 1}`,
    startMs: clip.startMs,
    endMs: clip.endMs,
    title: clip.title ?? clip.ideaKey ?? `Candidate ${index + 1}`,
    summary: clip.summary ?? clip.insightSummary ?? "Transcript-derived candidate",
  }));
  const evaluation = await evaluateAndRankCandidates({
    transcript,
    questions,
    candidates,
    client: jevClient,
  });
  const byId = new Map(packages.map((clip, index) => [`candidate-${index + 1}`, clip]));
  return evaluation.ranked.flatMap((ranked) => {
    const clip = byId.get(ranked.candidateId);
    return clip && !ranked.blocked && ranked.confidence >= 0.6
      ? [{ ...clip, score: ranked.score, jevConfidence: ranked.confidence }]
      : [];
  });
};
