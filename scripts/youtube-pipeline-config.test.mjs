import assert from "node:assert/strict";
import test from "node:test";

import {
  resolvePackageVersion,
  resolveSelectionConfig,
} from "./youtube-pipeline-config.mjs";

test("package version prefers the new variable and supports the legacy fallback", () => {
  assert.equal(
    resolvePackageVersion({
      AUDIOGRAM_PACKAGE_VERSION: "v3",
      AUDIOGRAM_TREATMENT_VERSION: "legacy",
    }),
    "v3",
  );
  assert.equal(
    resolvePackageVersion({ AUDIOGRAM_TREATMENT_VERSION: "legacy" }),
    "legacy",
  );
  assert.equal(resolvePackageVersion({}), "v1");
});

test("heatmap defaults are provider-free and strict numeric parsing preserves milliseconds", () => {
  const config = resolveSelectionConfig({
    OPENAI_API_KEY: "secret",
    AUDIOGRAM_LLM_PROVIDER: "chatgpt-oauth",
  });
  assert.equal(config.selectorId, "youtube-heatmap");
  assert.equal(config.providerId, null);
  assert.equal(config.maxClips, 1);
  assert.equal(config.minimumSeparationMs, 20000);
  assert.equal(JSON.stringify(config).includes("secret"), false);
  assert.equal(
    resolveSelectionConfig({
      AUDIOGRAM_MINIMUM_CLIP_SEPARATION_SECONDS: "0.001",
    }).minimumSeparationMs,
    1,
  );
  for (const value of [
    "",
    "1x",
    "1.5",
    "0",
    "-1",
    "Infinity",
    "9007199254740992",
  ])
    assert.throws(() => resolveSelectionConfig({ AUDIOGRAM_MAX_CLIPS: value }));
  for (const value of ["", "1x", "-1", "Infinity", "0.0001"])
    assert.throws(() =>
      resolveSelectionConfig({
        AUDIOGRAM_MINIMUM_CLIP_SEPARATION_SECONDS: value,
      }),
    );
  assert.throws(() => {
    config.maxClips = 7;
  });
});

test("transcript config requires explicit provider and bounded count without retaining credentials", () => {
  const env = { AUDIOGRAM_CLIP_SELECTOR: "transcript-llm" };
  assert.throws(
    () => resolveSelectionConfig({ ...env, OPENAI_API_KEY: "secret" }),
    /PROVIDER/,
  );
  assert.throws(
    () => resolveSelectionConfig({ ...env, AUDIOGRAM_LLM_PROVIDER: "other" }),
    /PROVIDER/,
  );
  assert.throws(
    () =>
      resolveSelectionConfig({ ...env, AUDIOGRAM_LLM_PROVIDER: "openai-api" }),
    /OPENAI_API_KEY/,
  );
  const config = resolveSelectionConfig({
    ...env,
    AUDIOGRAM_LLM_PROVIDER: "chatgpt-oauth",
  });
  assert.equal(config.packageVersion, "transcript-llm-v1");
  assert.equal(config.desiredClipCount, 3);
  assert.equal(config.model, "gpt-5.6-terra");
  assert.equal(config.limits.minimumClipMs, 30000);
  assert.equal(resolvePackageVersion(env), "transcript-llm-v1");
  for (const value of ["2", "6", "3.5", "3x", ""])
    assert.throws(() =>
      resolveSelectionConfig({
        ...env,
        AUDIOGRAM_LLM_PROVIDER: "chatgpt-oauth",
        AUDIOGRAM_TRANSCRIPT_CLIP_COUNT: value,
      }),
    );
  assert.equal(
    resolveSelectionConfig({
      ...env,
      AUDIOGRAM_LLM_PROVIDER: "chatgpt-oauth",
      AUDIOGRAM_TRANSCRIPT_CLIP_COUNT: "5",
    }).desiredClipCount,
    5,
  );
  assert.throws(() => {
    config.limits.minimumClipMs = 1;
  });
  assert.throws(() =>
    resolveSelectionConfig({ AUDIOGRAM_CLIP_SELECTOR: "other" }),
  );
});

test("legacy recipe mappings are strict and never replace live heatmap parameters", () => {
  const config = resolveSelectionConfig({
    AUDIOGRAM_LEGACY_HEATMAP_RECIPES_JSON:
      '{"v1":{"maxClips":4,"minimumSeparationMs":1234}}',
  });
  assert.deepEqual(config.legacyHeatmapRecipeMap, {
    v1: { maxClips: 4, minimumSeparationMs: 1234 },
  });
  assert.equal(config.maxClips, 1);
  assert.equal(config.minimumSeparationMs, 20000);
  for (const value of [
    "null",
    "[]",
    '{"v1":{"maxClips":1}}',
    '{"v1":{"maxClips":1,"minimumSeparationMs":0,"extra":1}}',
    '{"v1":{"maxClips":0,"minimumSeparationMs":0}}',
    '{"v1":{"maxClips":1,"minimumSeparationMs":0.1}}',
    '{"../v1":{"maxClips":1,"minimumSeparationMs":0}}',
  ])
    assert.throws(() =>
      resolveSelectionConfig({ AUDIOGRAM_LEGACY_HEATMAP_RECIPES_JSON: value }),
    );
});
