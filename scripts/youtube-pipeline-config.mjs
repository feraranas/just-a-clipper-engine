import { deepFreeze } from "./canonical-json.mjs";
import { selectorRegistry } from "./clip-selector-registry.mjs";
import {
  SELECTOR_MODEL,
  OAUTH_CODEX_VERSION,
  TRANSCRIPT_LIMITS,
} from "./clip-selection-contract.mjs";

export const resolvePackageVersion = (environment) =>
  environment.AUDIOGRAM_PACKAGE_VERSION ??
  environment.AUDIOGRAM_TREATMENT_VERSION ??
  (environment.AUDIOGRAM_CLIP_SELECTOR === "transcript-llm"
    ? "transcript-llm-v1"
    : environment.AUDIOGRAM_CLIP_SELECTOR === "question-analysis"
      ? "question-analysis-v1"
      : "v1");

const integer = (value, name, min = 1, max = Number.MAX_SAFE_INTEGER) => {
  if (
    typeof value !== "string" ||
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return Number(value);
};

const separationMs = (value) => {
  const name = "AUDIOGRAM_MINIMUM_CLIP_SEPARATION_SECONDS";
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value))
    throw new Error(
      `${name} must be a non-negative number with millisecond precision`,
    );
  const [whole, fraction = ""] = value.split(".");
  if (fraction.slice(3).replace(/0/g, "") !== "")
    throw new Error(`${name} must have millisecond precision`);
  const millis =
    Number(whole) * 1000 + Number(fraction.slice(0, 3).padEnd(3, "0"));
  if (!Number.isSafeInteger(millis))
    throw new Error(`${name} exceeds supported milliseconds`);
  return millis;
};

export const parseLegacyHeatmapRecipeMap = (value) => {
  if (value === undefined) return deepFreeze({});
  const fail = () => {
    throw new Error("Invalid AUDIOGRAM_LEGACY_HEATMAP_RECIPES_JSON mapping");
  };
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return fail();
  for (const [version, params] of Object.entries(parsed)) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(version) ||
      !params ||
      typeof params !== "object" ||
      Array.isArray(params) ||
      Object.keys(params).sort().join(",") !== "maxClips,minimumSeparationMs" ||
      !Number.isSafeInteger(params.maxClips) ||
      params.maxClips < 1 ||
      !Number.isSafeInteger(params.minimumSeparationMs) ||
      params.minimumSeparationMs < 0
    )
      return fail();
  }
  return deepFreeze(parsed);
};

export const resolveSelectionConfig = (environment = {}) => {
  const selector = selectorRegistry.get(
    environment.AUDIOGRAM_CLIP_SELECTOR ?? "youtube-heatmap",
    "1",
  );
  const common = {
    selectorId: selector.id,
    selectorVersion: selector.version,
    packageVersion: resolvePackageVersion(environment),
    legacyHeatmapRecipeMap: parseLegacyHeatmapRecipeMap(
      environment.AUDIOGRAM_LEGACY_HEATMAP_RECIPES_JSON,
    ),
  };
  if (selector.id === "youtube-heatmap")
    return deepFreeze({
      ...common,
      providerId: null,
      maxClips: integer(
        environment.AUDIOGRAM_MAX_CLIPS ?? "1",
        "AUDIOGRAM_MAX_CLIPS",
      ),
      minimumSeparationMs: separationMs(
        environment.AUDIOGRAM_MINIMUM_CLIP_SEPARATION_SECONDS ?? "20",
      ),
    });
  const providerId = environment.AUDIOGRAM_LLM_PROVIDER;
  if (!["openai-api", "chatgpt-oauth"].includes(providerId))
    throw new Error(
      "AUDIOGRAM_LLM_PROVIDER must explicitly select openai-api or chatgpt-oauth",
    );
  if (
    providerId === "openai-api" &&
    (typeof environment.OPENAI_API_KEY !== "string" ||
      !environment.OPENAI_API_KEY.trim())
  )
    throw new Error("OPENAI_API_KEY is required for openai-api");
  return deepFreeze({
    ...common,
    providerId,
    model:
      selector.id === "question-analysis"
        ? environment.AUDIOGRAM_QUESTION_ANALYSIS_MODEL ?? "gpt-5.6-terra"
        : SELECTOR_MODEL,
    codexVersion: OAUTH_CODEX_VERSION,
    desiredClipCount: integer(
      environment.AUDIOGRAM_TRANSCRIPT_CLIP_COUNT ?? "3",
      "AUDIOGRAM_TRANSCRIPT_CLIP_COUNT",
      3,
      5,
    ),
    limits: { ...TRANSCRIPT_LIMITS },
  });
};
