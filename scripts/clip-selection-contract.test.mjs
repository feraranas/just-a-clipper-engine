import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSelectionRecipe,
  buildTranscriptJsonSchema,
  buildTranscriptZodSchema,
  TRANSCRIPT_PROMPT,
  TRANSCRIPT_LIMITS,
  HEATMAP_SCHEMA_SHA256,
} from "./clip-selection-contract.mjs";
import { sha256Canonical } from "./canonical-json.mjs";

const base = {
  selectorId: "transcript-llm",
  providerId: "openai-api",
  desiredClipCount: 3,
};
const clip = {
  rank: 1,
  title: "A complete useful idea",
  ideaKey: "attention-switching",
  startCueId: "c000001",
  contextCueId: "c000002",
  insightCueId: "c000003",
  payoffCueId: "c000004",
  endCueId: "c000005",
  contextSummary: "Enough context for a new listener",
  insightSummary: "A substantive and nonobvious insight",
  payoffSummary: "A clear application of the insight",
  score: 0.94,
  editorialChecks: {
    selfContained: true,
    hasSetupBeforeClaim: true,
    completeThought: true,
    substantiveInsight: true,
    containsSponsorOrCta: false,
  },
};

test("recipe hashes include real prompt/schema and all behavior inputs", () => {
  const original = buildSelectionRecipe(base);
  assert.equal(
    original.recipe.prompt.sha256,
    sha256Canonical(TRANSCRIPT_PROMPT),
  );
  assert.equal(
    original.recipe.outputSchema.sha256,
    sha256Canonical(buildTranscriptJsonSchema(3)),
  );
  assert.equal(original.sha256, sha256Canonical(original.recipe));
  const variants = [
    { providerId: "chatgpt-oauth" },
    { model: "future-model" },
    { promptVersion: "v2" },
    { prompt: "new instructions" },
    { outputSchemaVersion: 2 },
    { outputSchema: { type: "object" } },
    { desiredClipCount: 4 },
    ...Object.keys(TRANSCRIPT_LIMITS).map((key) => ({
      limits: { ...TRANSCRIPT_LIMITS, [key]: TRANSCRIPT_LIMITS[key] + 1 },
    })),
  ];
  for (const variant of variants)
    assert.notEqual(
      buildSelectionRecipe({ ...base, ...variant }).sha256,
      original.sha256,
    );
  assert.notEqual(
    buildSelectionRecipe({
      ...base,
      providerId: "chatgpt-oauth",
      codexVersion: "next",
    }).sha256,
    buildSelectionRecipe({ ...base, providerId: "chatgpt-oauth" }).sha256,
  );
  assert.throws(() => {
    original.recipe.limits.minimumClipMs = 0;
  });
  for (const variant of [{ maxClips: 2 }, { minimumSeparationMs: 1 }])
    assert.notEqual(
      buildSelectionRecipe({ selectorId: "youtube-heatmap", ...variant })
        .sha256,
      buildSelectionRecipe({ selectorId: "youtube-heatmap" }).sha256,
    );
  assert.equal(
    buildSelectionRecipe({ selectorId: "youtube-heatmap" }).recipe.outputSchema
      .sha256,
    HEATMAP_SCHEMA_SHA256,
  );
});

test("JSON Schema recursively enumerates the exact strict transcript contract", () => {
  const schema = buildTranscriptJsonSchema(3);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["clips"]);
  assert.deepEqual(Object.keys(schema.properties), ["clips"]);
  assert.deepEqual(schema.properties.clips.type, "array");
  assert.equal(schema.properties.clips.minItems, 3);
  assert.equal(schema.properties.clips.maxItems, 3);
  const item = schema.properties.clips.items;
  assert.equal(item.type, "object");
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(Object.keys(item.properties), [
    "rank",
    "title",
    "ideaKey",
    "startCueId",
    "contextCueId",
    "insightCueId",
    "payoffCueId",
    "endCueId",
    "contextSummary",
    "insightSummary",
    "payoffSummary",
    "score",
    "editorialChecks",
  ]);
  assert.deepEqual(item.required, Object.keys(item.properties));
  assert.deepEqual(item.properties.rank, {
    type: "integer",
    minimum: 1,
    maximum: 3,
  });
  assert.deepEqual(item.properties.title, {
    type: "string",
    minLength: 12,
    maxLength: 80,
  });
  assert.deepEqual(item.properties.ideaKey, {
    type: "string",
    minLength: 3,
    maxLength: 48,
    pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
  });
  for (const name of [
    "startCueId",
    "contextCueId",
    "insightCueId",
    "payoffCueId",
    "endCueId",
  ])
    assert.deepEqual(item.properties[name], {
      type: "string",
      pattern: "^c\\d{6}$",
    });
  for (const name of ["contextSummary", "insightSummary", "payoffSummary"])
    assert.deepEqual(item.properties[name], {
      type: "string",
      minLength: 20,
      maxLength: 240,
    });
  assert.deepEqual(item.properties.score, {
    type: "number",
    minimum: 0,
    maximum: 1,
  });
  const editorial = item.properties.editorialChecks;
  assert.equal(editorial.type, "object");
  assert.equal(editorial.additionalProperties, false);
  assert.deepEqual(editorial.required, Object.keys(editorial.properties));
  assert.deepEqual(editorial.properties, {
    selfContained: { type: "boolean", const: true },
    hasSetupBeforeClaim: { type: "boolean", const: true },
    completeThought: { type: "boolean", const: true },
    substantiveInsight: { type: "boolean", const: true },
    containsSponsorOrCta: { type: "boolean", const: false },
  });
});

test("Zod enforces matching count, numeric, regex, literal, and Unicode boundaries", () => {
  const validator = buildTranscriptZodSchema(3);
  const valid = { clips: [clip, { ...clip, rank: 2 }, { ...clip, rank: 3 }] };
  assert.equal(validator.parse(valid).clips.length, 3);
  for (const change of [
    { title: "😀".repeat(11) },
    { title: "😀".repeat(81) },
    { score: NaN },
    { score: Infinity },
    { score: -Infinity },
    { score: -0.01 },
    { score: 1.01 },
    { rank: 0 },
    { rank: 4 },
    { rank: 1.5 },
    { ideaKey: "bad_key" },
    { startCueId: "c1" },
    { extra: true },
    { editorialChecks: { ...clip.editorialChecks, selfContained: false } },
  ])
    assert.equal(
      validator.safeParse({ clips: [{ ...clip, ...change }, clip, clip] })
        .success,
      false,
    );
  assert.equal(
    validator.parse({
      clips: [
        { ...clip, title: "  " + "e\u0301".repeat(12) + "  " },
        clip,
        clip,
      ],
    }).clips[0].title,
    "é".repeat(12),
  );
  assert.equal(
    validator.parse({
      clips: [{ ...clip, title: "😀".repeat(80) }, clip, clip],
    }).clips[0].title,
    "😀".repeat(80),
  );
  assert.equal(validator.safeParse({ clips: [clip] }).success, false);
  assert.equal(
    buildTranscriptZodSchema(4).safeParse({ clips: [...valid.clips, clip] })
      .success,
    true,
  );
  for (const [field, minimum, maximum] of [
    ["title", 12, 80],
    ["ideaKey", 3, 48],
    ["contextSummary", 20, 240],
    ["insightSummary", 20, 240],
    ["payoffSummary", 20, 240],
  ]) {
    const character = field === "ideaKey" ? "a" : "😀";
    assert.equal(
      validator.safeParse({
        clips: [{ ...clip, [field]: character.repeat(minimum) }, clip, clip],
      }).success,
      true,
    );
    assert.equal(
      validator.safeParse({
        clips: [{ ...clip, [field]: character.repeat(maximum) }, clip, clip],
      }).success,
      true,
    );
    assert.equal(
      validator.safeParse({
        clips: [
          { ...clip, [field]: character.repeat(minimum - 1) },
          clip,
          clip,
        ],
      }).success,
      false,
    );
    assert.equal(
      validator.safeParse({
        clips: [
          { ...clip, [field]: character.repeat(maximum + 1) },
          clip,
          clip,
        ],
      }).success,
      false,
    );
  }
});
