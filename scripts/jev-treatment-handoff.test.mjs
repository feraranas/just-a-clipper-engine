import assert from "node:assert/strict";
import test from "node:test";
import { renderProjectedPackages } from "./jev-treatment-handoff.mjs";

test("renders every projected package through the selected treatment", async () => {
  const calls = [];
  const result = await renderProjectedPackages({
    packages: [{ rank: 1, startMs: 0, endMs: 30000, analysisQuestionId: "main_idea" }],
    videoId: "video-1",
    packageVersion: "question-analysis-v1",
    assets: [{ role: "audio", relativePath: "public/audio.mp3" }],
    treatment: { id: "audiogram-basic", version: "1" },
    render: async (value) => { calls.push(value); return "out/clip-1.mp4"; },
  });
  assert.equal(calls[0].clipPackage.analysisQuestionId, "main_idea");
  assert.equal(result[0].artifactRelativePath, "out/clip-1.mp4");
  assert.equal(result[0].videoId, "video-1");
});
