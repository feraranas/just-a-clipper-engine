import { buildQuestionAnalysisJsonSchema } from "./question-analysis-contract.mjs";
import { evaluateAndRankCandidates } from "./jev-analysis.mjs";
import { persistJevEvaluation } from "./jev-ledger.mjs";

export const runQuestionAnalysis = async ({
  transcript,
  recipe,
  provider,
  jevClient,
  ledger,
  analysisId,
  timestamp,
  signal,
}) => {
  if (!provider || typeof provider.generateStructured !== "function")
    throw new Error("Question analysis provider is required");
  if (!jevClient) throw new Error("Jev client is required");
  const generated = await provider.generateStructured({
    instructions: "Analyze the timestamped transcript and propose grounded candidate evidence spans.",
    input: JSON.stringify({ recipe, transcript }),
    jsonSchema: buildQuestionAnalysisJsonSchema(),
    ...(signal ? { signal } : {}),
  });
  const analysis = generated?.parsed;
  if (!analysis || !Array.isArray(analysis.candidates))
    throw new Error("Question analysis provider returned invalid candidates");
  const evaluation = await evaluateAndRankCandidates({
    transcript,
    questions: recipe?.questions ?? [],
    candidates: analysis.candidates,
    client: jevClient,
  });
  const result = {
    analysis,
    provenance: generated.provenance,
    ...evaluation,
  };
  if (ledger) {
    persistJevEvaluation(ledger, {
      analysisId,
      recipeSha256: recipe?.sha256 ?? "unversioned",
      provenance: generated.provenance,
      judgments: result.judgments,
      ranked: result.ranked,
      timestamp,
    });
  }
  return result;
};
