import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {openAudiogramLedger} from "./audiogram-ledger.mjs";
import {processClipPackages} from "./clip-processing-core.mjs";
import {
  audiogramBasicTreatment,
  createTreatmentRegistry,
} from "./treatment-registry.mjs";

const seedPackages = (ledger, count = 1) => {
  ledger.syncPlaylistVideos({
    playlistId: "playlist-1",
    packageVersion: "v1",
    videos: [{videoId: "video-1", title: "A video", url: "https://youtu.be/video-1"}],
  });
  const job = ledger.getPackageJob("video-1", "v1");
  ledger.recordHeatmapSelection({
    jobId: job.id,
    heatmap: [],
    packages: Array.from({length: count}, (_, index) => ({
      rank: index + 1,
      startSeconds: index * 30,
      endSeconds: index * 30 + 20,
      score: 1 - index / 10,
    })),
  });
  return ledger.listClipPackages(job.id);
};

test("a completed package and treatment are skipped on the next run", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clip-processing-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"));
  t.after(() => ledger.close());
  seedPackages(ledger);
  let acquisitions = 0;
  let renders = 0;
  const dependencies = {
    ledger,
    registry: createTreatmentRegistry([audiogramBasicTreatment]),
    treatments: [{id: "audiogram-basic", version: "1"}],
    acquireAssets: async () => {
      acquisitions += 1;
      return [
        {role: "audio", relativePath: "public/audio.wav"},
        {role: "captions", relativePath: "public/captions.json"},
        {role: "thumbnail", relativePath: "public/thumbnail.jpg"},
      ];
    },
    renderTreatment: async () => {
      renders += 1;
      return "out/treatments/audiogram-basic/1/video-1/clip-1.mp4";
    },
  };

  const first = await processClipPackages(dependencies);
  const second = await processClipPackages(dependencies);

  assert.equal(acquisitions, 1);
  assert.equal(renders, 1);
  assert.deepEqual(first, {
    packages: {ready: 1, failed: 0},
    treatments: {rendered: 1, failed: 0},
  });
  assert.deepEqual(second, {
    packages: {ready: 0, failed: 0},
    treatments: {rendered: 0, failed: 0},
  });
});

test("a failed package does not prevent another package from rendering", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clip-processing-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"));
  t.after(() => ledger.close());
  const packages = seedPackages(ledger, 2);

  const result = await processClipPackages({
    ledger,
    registry: createTreatmentRegistry([audiogramBasicTreatment]),
    treatments: [{id: "audiogram-basic", version: "1"}],
    acquireAssets: async (clipPackage) => {
      if (clipPackage.rank === 1) throw new Error("caption download failed");
      return [
        {role: "audio", relativePath: "public/audio.wav"},
        {role: "captions", relativePath: "public/captions.json"},
        {role: "thumbnail", relativePath: "public/thumbnail.jpg"},
      ];
    },
    renderTreatment: async () => "out/clip-2.mp4",
  });

  assert.deepEqual(result, {
    packages: {ready: 1, failed: 1},
    treatments: {rendered: 1, failed: 0},
  });
  assert.equal(ledger.getClipPackage(packages[0].id).status, "failed");
  assert.equal(ledger.getClipPackage(packages[1].id).status, "ready");
  assert.equal(ledger.listTreatmentRuns(packages[1].id)[0].status, "rendered");
});

test("a render failure leaves the reusable package ready", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clip-processing-"));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"));
  t.after(() => ledger.close());
  const [clipPackage] = seedPackages(ledger);

  const result = await processClipPackages({
    ledger,
    registry: createTreatmentRegistry([audiogramBasicTreatment]),
    treatments: [{id: "audiogram-basic", version: "1"}],
    acquireAssets: async () => [
      {role: "audio", relativePath: "public/audio.wav"},
      {role: "captions", relativePath: "public/captions.json"},
      {role: "thumbnail", relativePath: "public/thumbnail.jpg"},
    ],
    renderTreatment: async () => {
      throw new Error("browser failed");
    },
  });

  assert.deepEqual(result, {
    packages: {ready: 1, failed: 0},
    treatments: {rendered: 0, failed: 1},
  });
  assert.equal(ledger.getClipPackage(clipPackage.id).status, "ready");
  assert.equal(ledger.listTreatmentRuns(clipPackage.id)[0].status, "failed");
});
