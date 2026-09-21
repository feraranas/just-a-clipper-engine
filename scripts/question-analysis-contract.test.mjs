import assert from "node:assert/strict";
import test from "node:test";

import {
  QUESTION_ANALYSIS_VERSION,
  QUESTION_DEFINITIONS,
  buildQuestionAnalysisJsonSchema,
  buildQuestionAnalysisRecipe,
} from "./question-analysis-contract.mjs";

test("defines stable framework questions with typed judgment primitives", () => {
  assert.equal(QUESTION_ANALYSIS_VERSION, "question-analysis-v1");
  assert.ok(QUESTION_DEFINITIONS.length >= 8);
  assert.deepEqual(
    QUESTION_DEFINITIONS.map(({ id, type }) => ({ id, type })),
    [
      { id: "video_about", type: "choice" },
      { id: "main_idea", type: "choice" },
      { id: "secondary_ideas", type: "choice" },
      { id: "problem_or_tension", type: "choice" },
      { id: "supporting_evidence", type: "choice" },
      { id: "surprising_point", type: "choice" },
      { id: "practical_implication", type: "choice" },
      { id: "conclusion_or_recommendation", type: "choice" },
    ],
  );
  for (const question of QUESTION_DEFINITIONS) {
    assert.match(question.id, /^[a-z][a-z0-9_]+$/);
    assert.ok(question.instructions);
    assert.ok(question.criteria);
  }
});

test("builds a strict analysis schema and a reproducible hashed recipe", () => {
  const schema = buildQuestionAnalysisJsonSchema();
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["answers", "candidates"]);
  assert.equal(schema.properties.answers.items.additionalProperties, false);
  assert.equal(schema.properties.candidates.items.additionalProperties, false);

  const recipe = buildQuestionAnalysisRecipe();
  assert.equal(recipe.version, QUESTION_ANALYSIS_VERSION);
  assert.match(recipe.sha256, /^[a-f0-9]{64}$/);
  assert.equal(recipe.questions.length, QUESTION_DEFINITIONS.length);
  assert.deepEqual(recipe, buildQuestionAnalysisRecipe());
});
