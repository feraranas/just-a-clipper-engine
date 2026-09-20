import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSelectionRecipe,
  buildTranscriptJsonSchema,
  SELECTOR_MODEL,
  TRANSCRIPT_OUTPUT_SCHEMA_VERSION,
} from "./clip-selection-contract.mjs";
import { createStructuredGenerationProvider } from "./structured-generation-provider.mjs";
import {
  buildTranscriptPrompt,
  deriveClipSelections,
} from "./transcript-selector.mjs";
import { resolveSelectionConfig } from "./youtube-pipeline-config.mjs";

const LIVE_SMOKE_AUTHORIZATION = "AUDIOGRAM_RUN_LIVE_SELECTOR_SMOKE";
const LIVE_SMOKE_AUTHORIZED_VALUE = "1";
const supportedProviders = new Set(["openai-api", "chatgpt-oauth"]);

const cue = (id, startMs, endMs, text) => ({ id, startMs, endMs, text });

const syntheticTranscript = Object.freeze({
  source: "synthetic-smoke",
  language: "en",
  cues: Object.freeze([
    cue(
      "c000001",
      0,
      8_000,
      "A team can lose days when every uncertain detail is treated as equally urgent.",
    ),
    cue(
      "c000002",
      8_000,
      16_000,
      "Start by naming the decision that is currently blocked and the evidence it needs.",
    ),
    cue(
      "c000003",
      16_000,
      24_000,
      "The useful unit of progress is uncertainty removed, not documents or meetings produced.",
    ),
    cue(
      "c000004",
      24_000,
      32_000,
      "That reframes research into the smallest observation capable of changing the decision.",
    ),
    cue(
      "c000005",
      32_000,
      40_000,
      "Teams then stop sooner, decide sooner, and retain the evidence that justified the choice.",
    ),
    cue(
      "c000006",
      60_000,
      68_000,
      "Plans often hide assumptions by presenting one polished route as if it were inevitable.",
    ),
    cue(
      "c000007",
      68_000,
      76_000,
      "Write down the assumption whose failure would most quickly invalidate that route.",
    ),
    cue(
      "c000008",
      76_000,
      84_000,
      "A small reversible test is valuable because it attacks the assumption before the investment compounds.",
    ),
    cue(
      "c000009",
      84_000,
      92_000,
      "The result can support the route, narrow it, or retire it while the cost is still low.",
    ),
    cue(
      "c000010",
      92_000,
      100_000,
      "That makes the roadmap a sequence of evidence purchases instead of a list of promises.",
    ),
    cue(
      "c000011",
      120_000,
      128_000,
      "Experience alone does not guarantee learning when outcomes are remembered selectively.",
    ),
    cue(
      "c000012",
      128_000,
      136_000,
      "Before acting, record the prediction and the observation that would prove it wrong.",
    ),
    cue(
      "c000013",
      136_000,
      144_000,
      "Comparing a dated prediction with reality converts confidence into evidence about judgment.",
    ),
    cue(
      "c000014",
      144_000,
      152_000,
      "The mismatch reveals whether the model, the measurement, or the execution needs revision.",
    ),
    cue(
      "c000015",
      152_000,
      160_000,
      "Repeated honestly, that loop compounds learning instead of merely accumulating anecdotes.",
    ),
  ]),
});

const summary = ({
  providerId,
  recipeSha256,
  responseId,
  clipCount,
  status,
}) => ({
  providerId,
  model: SELECTOR_MODEL,
  recipeSha256,
  responseId,
  schemaVersion: TRANSCRIPT_OUTPUT_SCHEMA_VERSION,
  clipCount,
  status,
});

export const smokeFailureSummary = (environment = {}) =>
  summary({
    providerId: supportedProviders.has(environment.AUDIOGRAM_LLM_PROVIDER)
      ? environment.AUDIOGRAM_LLM_PROVIDER
      : null,
    recipeSha256: null,
    responseId: null,
    clipCount: 0,
    status: "fail",
  });

export const runClipSelectorSmoke = async ({
  environment = process.env,
  createProvider = createStructuredGenerationProvider,
  providerDependencies = {},
  print = console.log,
} = {}) => {
  if (environment[LIVE_SMOKE_AUTHORIZATION] !== LIVE_SMOKE_AUTHORIZED_VALUE) {
    print("live smoke test not authorized");
    return { authorized: false };
  }

  const selectionConfig = resolveSelectionConfig({
    ...environment,
    AUDIOGRAM_CLIP_SELECTOR: "transcript-llm",
    AUDIOGRAM_TRANSCRIPT_CLIP_COUNT: "3",
  });
  const selectionRecipe = buildSelectionRecipe(selectionConfig);
  const provider = createProvider(selectionConfig, {
    ...providerDependencies,
    environment,
  });
  const prompt = buildTranscriptPrompt(syntheticTranscript);
  const generated = await provider.generateStructured({
    instructions: prompt.instructions,
    input: prompt.input,
    jsonSchema: buildTranscriptJsonSchema(3),
  });
  if (
    generated?.provenance?.providerId !== selectionConfig.providerId ||
    generated?.provenance?.model !== selectionConfig.model ||
    generated?.provenance?.recipeSha256 !== selectionRecipe.sha256
  )
    throw new Error("Live selector smoke provenance mismatch");

  const clips = deriveClipSelections(
    generated.parsed,
    syntheticTranscript,
    selectionRecipe.recipe,
  );
  const smokeSummary = summary({
    providerId: selectionConfig.providerId,
    recipeSha256: selectionRecipe.sha256,
    responseId: generated.provenance.responseId ?? null,
    clipCount: clips.length,
    status: "pass",
  });
  print(JSON.stringify(smokeSummary));
  return { authorized: true, clips, summary: smokeSummary };
};

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runClipSelectorSmoke().catch(() => {
    console.log(JSON.stringify(smokeFailureSummary(process.env)));
    process.exitCode = 1;
  });
}
