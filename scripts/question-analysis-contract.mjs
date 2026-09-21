import { deepFreeze, sha256Canonical } from "./canonical-json.mjs";

export const QUESTION_ANALYSIS_VERSION = "question-analysis-v1";

const question = (id, instructions, criteria) =>
  deepFreeze({ id, type: "choice", instructions, criteria });

export const QUESTION_DEFINITIONS = deepFreeze([
  question(
    "video_about",
    "Which candidate best answers what this video is about?",
    {
      candidate:
        "A concise, representative description of the video's subject and scope.",
      none: "No candidate captures the video's subject.",
    },
  ),
  question("main_idea", "Which candidate best states the video's main idea?", {
    candidate: "The central claim or thesis that organizes the discussion.",
    none: "No candidate states a defensible central idea.",
  }),
  question(
    "secondary_ideas",
    "Which candidate best represents an important secondary idea?",
    {
      candidate:
        "A distinct substantive idea that supports or extends the main idea.",
      none: "No candidate is a meaningful secondary idea.",
    },
  ),
  question(
    "problem_or_tension",
    "Which candidate best states the problem, tension, or question being discussed?",
    {
      candidate:
        "A concrete problem, tradeoff, unresolved question, or tension in the transcript.",
      none: "No candidate establishes a meaningful problem or tension.",
    },
  ),
  question(
    "supporting_evidence",
    "Which candidate provides the strongest supporting evidence or example?",
    {
      candidate:
        "A specific example, observation, fact, or story that supports an idea.",
      none: "No candidate provides grounded support.",
    },
  ),
  question(
    "surprising_point",
    "Which candidate contains the most non-obvious or surprising point?",
    {
      candidate:
        "A substantive point that would not be obvious from the video's topic alone.",
      none: "No candidate contains a defensible surprising point.",
    },
  ),
  question(
    "practical_implication",
    "Which candidate best explains a practical implication or application?",
    {
      candidate:
        "A consequence, decision, action, or application that follows from the discussion.",
      none: "No candidate has a concrete practical implication.",
    },
  ),
  question(
    "conclusion_or_recommendation",
    "Which candidate best captures the speaker's conclusion or recommendation?",
    {
      candidate:
        "A closing conclusion, recommendation, or implication grounded in the transcript.",
      none: "No candidate contains a clear conclusion or recommendation.",
    },
  ),
]);

const strictObject = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const cueIds = {
  type: "array",
  minItems: 1,
  items: { type: "string", pattern: "^c\\d{6}$" },
};

export const buildQuestionAnalysisJsonSchema = () =>
  deepFreeze(
    strictObject({
      answers: {
        type: "array",
        items: strictObject({
          questionId: { type: "string", pattern: "^[a-z][a-z0-9_]+$" },
          answer: { type: "string", minLength: 1, maxLength: 600 },
          candidateId: { type: "string", pattern: "^candidate-[a-z0-9-]+$" },
          evidenceCueIds: cueIds,
          evidenceQuality: {
            type: "string",
            enum: ["strong", "mixed", "weak"],
          },
          epistemicStatus: { type: "string", enum: ["explicit", "inferred"] },
        }),
      },
      candidates: {
        type: "array",
        items: strictObject({
          candidateId: { type: "string", pattern: "^candidate-[a-z0-9-]+$" },
          startCueId: { type: "string", pattern: "^c\\d{6}$" },
          endCueId: { type: "string", pattern: "^c\\d{6}$" },
          title: { type: "string", minLength: 1, maxLength: 120 },
          summary: { type: "string", minLength: 1, maxLength: 600 },
        }),
      },
    }),
  );

export const buildQuestionAnalysisRecipe = () => {
  const recipe = {
    version: QUESTION_ANALYSIS_VERSION,
    questions: QUESTION_DEFINITIONS,
    outputSchema: buildQuestionAnalysisJsonSchema(),
  };
  return deepFreeze({ ...recipe, sha256: sha256Canonical(recipe) });
};

export const QUESTION_ANALYSIS_RECIPE_SHA256 = sha256Canonical(
  buildQuestionAnalysisRecipe(),
);
