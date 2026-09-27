import { buildQuestionAnalysisJsonSchema } from "./question-analysis-contract.mjs";
import { evaluateAndRankCandidates } from "./jev-analysis.mjs";

export const runQuestionAnalysis = async ({
  transcript,
  recipe,
  provider,
  jevClient,
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
  return {
    analysis,
    provenance: generated.provenance,
    ...evaluation,
  };
};
