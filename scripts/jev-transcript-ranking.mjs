import { evaluateAndRankCandidates } from "./jev-analysis.mjs";

const dimensions = ["relevance", "insight", "selfContainedness"];
const nouls = ["completeThought", "containsSponsorOrCta", "citationSupported"];

const questionMapFor = (candidates) => Object.fromEntries(candidates.flatMap((candidate) => [
  ...dimensions.map((dimension) => [`${candidate.candidateId}.${dimension}`, {
    type: "score",
    instructions: `Rate the candidate's ${dimension} for a publishable short clip from 0 to 1.`,
    criteria: ["0", "0.25", "0.5", "0.75", "1"],
  }]),
  ...nouls.map((noul) => [`${candidate.candidateId}.${noul}`, {
    type: "noul",
    instructions: noul === "containsSponsorOrCta"
      ? "Does this candidate contain sponsor copy or a call to action?"
      : noul === "completeThought"
        ? "Does this candidate express a complete thought?"
        : "Is this candidate supported by the supplied transcript?",
  }]),
]));

const answerValue = (answer) => Number.isFinite(Number(answer?.score)) ? Number(answer.score) / 4 : 0;
const answerNoul = (answer) => Number(answer?.noul) >= 0.5;
const normalizeAnswers = (answers, candidates) => Object.fromEntries(candidates.map((candidate) => {
  const prefix = `${candidate.candidateId}.`;
  const answer = (name) => answers?.[`${prefix}${name}`];
  const confidenceValues = [...dimensions, ...nouls]
    .map((name) => Number(answer(name)?.confidence))
    .filter(Number.isFinite);
  const confidence = confidenceValues.length > 0
    ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
    : 0;
  return [candidate.candidateId, {
    scores: Object.fromEntries(dimensions.map((name) => [name, answerValue(answer(name))])),
    nouls: Object.fromEntries(nouls.map((name) => [name, answerNoul(answer(name))])),
    confidence: Number.isFinite(confidence) ? confidence : 0,
  }];
}));

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
    questions: questionMapFor(candidates),
    candidates,
    client: {
      async judgeCandidates(request) {
        const answers = await jevClient.judgeCandidates(request);
        return normalizeAnswers(answers, candidates);
      },
    },
  });
  const byId = new Map(packages.map((clip, index) => [`candidate-${index + 1}`, clip]));
  return evaluation.ranked.flatMap((ranked) => {
    const clip = byId.get(ranked.candidateId);
    return clip && !ranked.blocked
      ? [{ ...clip, score: ranked.score, jevConfidence: ranked.confidence }]
      : [];
  });
};
