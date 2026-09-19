import assert from "node:assert/strict";
import test from "node:test";

import {
  audiogramBasicTreatment,
  createTreatmentRegistry,
} from "./treatment-registry.mjs";

const clipPackage = {
  title: "A useful clip",
  assets: [
    {role: "audio", relativePath: "public/generated/video-1/v1/clip-1/audio.wav"},
    {role: "captions", relativePath: "public/generated/video-1/v1/clip-1/captions.json"},
    {role: "thumbnail", relativePath: "public/generated/video-1/v1/clip-1/thumbnail.jpg"},
  ],
};

test("registers audiogram-basic@1 and builds public-relative render props", () => {
  const registry = createTreatmentRegistry([audiogramBasicTreatment]);
  const treatment = registry.get("audiogram-basic", "1");

  assert.equal(treatment.compositionId, "AudiogramBasic");
  assert.deepEqual(treatment.output, {extension: "mp4", codec: "h264"});
  assert.deepEqual(treatment.buildProps(clipPackage), {
    title: "A useful clip",
    audioFileName: "generated/video-1/v1/clip-1/audio.wav",
    captionsFileName: "generated/video-1/v1/clip-1/captions.json",
    coverImageFileName: "generated/video-1/v1/clip-1/thumbnail.jpg",
  });
});

test("rejects unknown and duplicate treatment keys", () => {
  const registry = createTreatmentRegistry([audiogramBasicTreatment]);
  assert.throws(
    () => registry.get("missing", "1"),
    /Unknown treatment: missing@1/,
  );
  assert.throws(
    () => createTreatmentRegistry([audiogramBasicTreatment, audiogramBasicTreatment]),
    /Duplicate treatment: audiogram-basic@1/,
  );
});

test("rejects packages that omit a required asset", () => {
  const registry = createTreatmentRegistry([audiogramBasicTreatment]);
  assert.throws(
    () =>
      registry.get("audiogram-basic", "1").buildProps({
        ...clipPackage,
        assets: clipPackage.assets.filter(({role}) => role !== "captions"),
      }),
    /Missing required asset: captions/,
  );
});
