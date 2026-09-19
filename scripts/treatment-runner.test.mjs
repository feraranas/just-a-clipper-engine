import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {renderTreatmentRun} from "./treatment-runner.mjs";

test("renders any registry treatment to its deterministic artifact path", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "treatment-runner-"));
  t.after(() => rm(projectRoot, {recursive: true, force: true}));
  const calls = [];
  const runCommand = async (command, args) => {
    calls.push({command, args});
    await writeFile(args[3], "rendered media");
  };
  const treatment = {
    id: "future-treatment",
    version: "2",
    compositionId: "FutureComposition",
    output: {extension: "mp4", codec: "h264"},
    buildProps: (clipPackage) => ({title: clipPackage.title}),
  };

  const artifactRelativePath = await renderTreatmentRun(
    {
      clipPackage: {videoId: "video-1", rank: 3, title: "A clip", assets: []},
      treatment,
    },
    {projectRoot, runCommand},
  );

  assert.equal(
    artifactRelativePath,
    "out/treatments/future-treatment/2/video-1/clip-3.mp4",
  );
  assert.deepEqual(calls[0], {
    command: "npx",
    args: [
      "remotion",
      "render",
      "FutureComposition",
      join(
        projectRoot,
        "out/treatments/future-treatment/2/video-1/.clip-3.partial.mp4",
      ),
      `--props=${join(projectRoot, "out/treatments/future-treatment/2/video-1/clip-3.props.json")}`,
      "--codec=h264",
    ],
  });
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(
          projectRoot,
          "out/treatments/future-treatment/2/video-1/clip-3.props.json",
        ),
        "utf8",
      ),
    ),
    {title: "A clip"},
  );
  assert.equal(
    (
      await stat(
        join(
          projectRoot,
          "out/treatments/future-treatment/2/video-1/clip-3.mp4",
        ),
      )
    ).size,
    14,
  );
});

test("does not publish an empty partial render", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "treatment-runner-"));
  t.after(() => rm(projectRoot, {recursive: true, force: true}));
  const treatment = {
    id: "audiogram-basic",
    version: "1",
    compositionId: "AudiogramBasic",
    output: {extension: "mp4", codec: "h264"},
    buildProps: () => ({}),
  };

  await assert.rejects(
    renderTreatmentRun(
      {clipPackage: {videoId: "video-1", rank: 1}, treatment},
      {
        projectRoot,
        runCommand: async (_command, args) => writeFile(args[3], ""),
      },
    ),
    /Rendered artifact is empty/,
  );
});
