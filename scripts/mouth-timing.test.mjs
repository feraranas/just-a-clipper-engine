import test from "node:test";
import assert from "node:assert/strict";
import {
  validateMouthCues,
  mouthAt,
} from "../src/PresenterDemo/mouth-timing.mjs";
test("mouth switches on cue boundaries and rests in silence", () => {
  const cues = validateMouthCues(
    [
      { start: 0.2, end: 0.5, value: "A" },
      { start: 0.5, end: 1, value: "F" },
    ],
    2,
  );
  assert.equal(mouthAt(cues, 0), "X");
  assert.equal(mouthAt(cues, 0.3), "A");
  assert.equal(mouthAt(cues, 0.5), "F");
  assert.equal(mouthAt(cues, 1), "X");
});
test("invalid shapes, overlapping times and out-of-audio cues fail", () => {
  for (const cues of [
    [{ start: 0, end: 1, value: "Z" }],
    [
      { start: 0, end: 1, value: "A" },
      { start: 0.5, end: 2, value: "B" },
    ],
    [{ start: 0, end: 3, value: "A" }],
  ])
    assert.throws(() => validateMouthCues(cues, 2));
});
