import test from "node:test";
import assert from "node:assert/strict";
import {
  mouthPoseAt,
  mouthPoses,
} from "../src/PresenterDemo/mouth-transitions.mjs";
test("long vowels use an intermediate before reaching the full opening", () => {
  const cues = [{ start: 0, end: 1, value: "D" }];
  assert.equal(mouthPoseAt(cues, 0, 24), 11);
  assert.equal(mouthPoseAt(cues, 2, 24), 4);
  assert.equal(mouthPoseAt(cues, 23, 24), 10);
});
test("brief consonants and closures are not lost to transitions", () => {
  assert.equal(mouthPoseAt([{ start: 0, end: 0.1, value: "G" }], 1, 24), 7);
  assert.equal(mouthPoseAt([{ start: 0, end: 1, value: "A" }], 0, 24), 1);
});
test("gaps, negative time, and the recording end return to rest", () => {
  const cues = [{ start: 0.5, end: 1, value: "C" }];
  for (const frame of [-1, 0, 24, 100])
    assert.equal(mouthPoseAt(cues, frame, 24), 0);
});
test("palette defines exactly twenty reachable cell indices", () => {
  const seen = new Set(Object.values(mouthPoses).flatMap(Object.values));
  assert.deepEqual(
    [...seen].sort((a, b) => a - b),
    Array.from({ length: 20 }, (_, i) => i),
  );
});
test("successive equal cues do not restart opening", () => {
  const cues = [
    { start: 0, end: 1, value: "C" },
    { start: 1, end: 2, value: "C" },
  ];
  assert.equal(mouthPoseAt(cues, 23, 24), 3);
  assert.equal(mouthPoseAt(cues, 24, 24), 3);
});
test("invalid frame rate fails explicitly", () =>
  assert.throws(() => mouthPoseAt([], 0, 0)));
