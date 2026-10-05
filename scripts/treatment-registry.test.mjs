import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRequiredAssets,
  audiogramBasicTreatment,
  createTreatmentRegistry,
} from "./treatment-registry.mjs";

const clipPackage = {
  title: "A useful clip",
  assets: [
    {
      role: "audio",
      relativePath: "public/generated/video-1/v1/clip-1/audio.wav",
    },
    {
      role: "captions",
      relativePath: "public/generated/video-1/v1/clip-1/captions.json",
    },
    {
      role: "thumbnail",
      relativePath: "public/generated/video-1/v1/clip-1/thumbnail.jpg",
    },
  ],
};

test("registers audiogram-basic@1 and builds public-relative render props", () => {
  const registry = createTreatmentRegistry([audiogramBasicTreatment]);
  const treatment = registry.get("audiogram-basic", "1");

  assert.equal(treatment.compositionId, "AudiogramBasic");
  assert.deepEqual(treatment.output, { extension: "mp4", codec: "h264" });
  assert.deepEqual(treatment.buildProps(clipPackage), {
    titleColor: "rgba(186, 186, 186, 0.93)",
    captionsTextColor: "rgba(255, 255, 255, 0.93)",
    onlyDisplayCurrentSentence: true,
    visualizer: {type:"oscilloscope",color:"#6B6B6B",numberOfSamples:"32",windowInSeconds:0.1,posterization:3,amplitude:4,padding:50},
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
    () =>
      createTreatmentRegistry([
        audiogramBasicTreatment,
        audiogramBasicTreatment,
      ]),
    /Duplicate treatment: audiogram-basic@1/,
  );
});

test("rejects packages that omit a required asset", () => {
  const registry = createTreatmentRegistry([audiogramBasicTreatment]);
  assert.throws(() => {
    const treatment = registry.get("audiogram-basic", "1");
    assertRequiredAssets(treatment, {
      ...clipPackage,
      assets: clipPackage.assets.filter(({ role }) => role !== "captions"),
    });
  }, /Missing required asset: captions/);
});

test("rejects malformed treatment definitions at registration", () => {
  assert.throws(
    () =>
      createTreatmentRegistry([
        { ...audiogramBasicTreatment, requiredAssetRoles: ["audio", "audio"] },
      ]),
    /Duplicate required asset role: audio/,
  );
  assert.throws(
    () =>
      createTreatmentRegistry([
        { ...audiogramBasicTreatment, buildProps: null },
      ]),
    /buildProps must be a function/,
  );
  assert.throws(
    () =>
      createTreatmentRegistry([
        { ...audiogramBasicTreatment, compositionId: "" },
      ]),
    /compositionId must be a non-empty string/,
  );
  assert.throws(
    () =>
      createTreatmentRegistry([
        {
          ...audiogramBasicTreatment,
          output: { extension: "../zip", codec: "h264" },
        },
      ]),
    /Unsupported output extension: \.\.\/zip/,
  );
  assert.throws(
    () =>
      createTreatmentRegistry([
        {
          ...audiogramBasicTreatment,
          output: { extension: "mp4", codec: "vp9" },
        },
      ]),
    /Unsupported output codec: vp9/,
  );
});

test("rejects navigation treatment path components at registration", () => {
  for (const [field, label] of [
    ["id", "treatment ID"],
    ["version", "treatment version"],
  ]) {
    for (const value of [".", ".."]) {
      assert.throws(
        () =>
          createTreatmentRegistry([
            { ...audiogramBasicTreatment, [field]: value },
          ]),
        { message: `Invalid ${label}: ${value}` },
      );
    }
  }
});
