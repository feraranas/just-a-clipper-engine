import assert from "node:assert/strict";
import test from "node:test";
import {
  compareParityRecords,
  readParityRecord,
} from "./verify-classic-parity.mjs";
const record = {
  width: 1080,
  height: 1920,
  fps: "30/1",
  frames: ["0,hash-a", "1,hash-b"],
  audioHash: "abc",
  sampleRate: "16000",
  channels: 1,
};
test("identical decoded records match", () =>
  assert.deepEqual(compareParityRecords(record, structuredClone(record)), {
    equal: true,
    reason: null,
  }));
for (const [field, value] of Object.entries({
  width: 720,
  height: 1080,
  fps: "25/1",
  frames: ["0,hash-a"],
  audioHash: "changed",
  sampleRate: "48000",
  channels: 2,
})) {
  test(`rejects changed ${field}`, () =>
    assert.equal(
      compareParityRecords(record, { ...record, [field]: value }).equal,
      false,
    ));
}
test("rejects a changed frame at equal frame count", () =>
  assert.equal(
    compareParityRecords(record, {
      ...record,
      frames: ["0,hash-a", "1,changed"],
    }).equal,
    false,
  ));
test("rejects missing audio on both sides", () =>
  assert.equal(
    compareParityRecords(
      { ...record, audioHash: null },
      { ...record, audioHash: null },
    ).equal,
    false,
  ));
test("missing input fails instead of matching", async () =>
  assert.rejects(readParityRecord("/no-such-classic-fixture.mp4")));
