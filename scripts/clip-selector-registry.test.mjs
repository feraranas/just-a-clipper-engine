import assert from "node:assert/strict";
import test from "node:test";
import { selectorRegistry } from "./clip-selector-registry.mjs";

test("selector registry allows only explicit versioned runtime selectors", () => {
  assert.deepEqual(selectorRegistry.get("youtube-heatmap", "1"), {
    id: "youtube-heatmap",
    version: "1",
  });
  assert.equal(
    selectorRegistry.get("transcript-llm", "1").id,
    "transcript-llm",
  );
  for (const [id, version] of [
    ["unknown", "1"],
    ["transcript-llm", "2"],
    ["youtube-heatmap-legacy", "0"],
  ])
    assert.throws(() => selectorRegistry.get(id, version));
  assert.throws(() => {
    selectorRegistry.get("youtube-heatmap", "1").version = "2";
  });
});
