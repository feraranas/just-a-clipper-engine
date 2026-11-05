import test from "node:test";
import assert from "node:assert/strict";
import { deriveSceneTiming } from "../src/PresenterDemo/scene-timing.mjs";
test("aligns scenes to narration, preserving silence and every approved word", () => {
  const result = deriveSceneTiming(
    [{ text: "Hello, world." }, { text: "Next." }],
    [
      { text: "Hello", start: 0.2, end: 0.5 },
      { text: "world.", start: 0.6, end: 1 },
      { text: "Next.", start: 1.5, end: 1.9 },
    ],
    2,
  );
  assert.deepEqual(result.segments, [
    { text: "Hello, world.", start: 0, end: 1.5 },
    { text: "Next.", start: 1.5, end: 2 },
  ]);
});
test("refuses mismatched or unaccounted words", () => {
  const words = [{ text: "different", start: 0, end: 1 }];
  assert.throws(
    () => deriveSceneTiming([{ text: "hello" }], words, 2),
    /match/,
  );
  assert.throws(
    () =>
      deriveSceneTiming(
        [{ text: "hello" }],
        [
          { text: "hello", start: 0, end: 1 },
          { text: "extra", start: 1, end: 2 },
        ],
        3,
      ),
    /unmatched/i,
  );
});

test("the saved comparison timing matches every word of the actual Liam narration", async () => {
  const { default: baseline } = await import(
    "../src/PresenterDemo/timing.json",
    { with: { type: "json" } }
  );
  const { default: liam } = await import(
    "../src/PresenterDemo/liam-cues.json",
    { with: { type: "json" } }
  );
  const { default: saved } = await import(
    "../src/PresenterDemo/liam-scene-timing.json",
    { with: { type: "json" } }
  );
  assert.deepEqual(
    deriveSceneTiming(baseline.segments, liam.words, liam.duration),
    saved,
  );
});
