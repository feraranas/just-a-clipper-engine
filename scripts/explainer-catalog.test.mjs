import test from "node:test";
import assert from "node:assert/strict";
import {
  sceneSchema,
  validateScenePlan,
  listSceneBlocks,
} from "../src/Explainer/catalog.mjs";
test("blocks reject unknown types, versions, and excessive text", () => {
  assert.equal(
    sceneSchema.safeParse({ kind: "eval", version: 1, title: "x", items: [] })
      .success,
    false,
  );
  assert.equal(
    sceneSchema.safeParse({
      kind: "process",
      version: 2,
      title: "x",
      items: ["a", "b"],
    }).success,
    false,
  );
  assert.equal(
    sceneSchema.safeParse({
      kind: "process",
      version: 1,
      title: "x".repeat(100),
      items: ["a", "b"],
    }).success,
    false,
  );
  assert.equal(listSceneBlocks().length, 3);
});
test("scene plan is linked one to one to approved script segments", () => {
  const script = { segments: [{ id: "a", text: "hello" }] };
  const scene = {
    segmentId: "a",
    kind: "comparison",
    version: 1,
    title: "Choose",
    items: ["known pattern", "consequence"],
  };
  assert.equal(validateScenePlan({ scenes: [scene] }, script).scenes.length, 1);
  assert.throws(() =>
    validateScenePlan({ scenes: [{ ...scene, segmentId: "other" }] }, script),
  );
  assert.throws(() => validateScenePlan({ scenes: [] }, script));
});
