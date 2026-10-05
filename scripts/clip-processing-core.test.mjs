import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { openAudiogramLedger } from "./audiogram-ledger.mjs";
import { acquireClipPackageAssets } from "./clip-package-assets.mjs";
import { processClipPackages } from "./clip-processing-core.mjs";
import { buildSelectionRecipe } from "./clip-selection-contract.mjs";
import {
  audiogramBasicTreatment,
  createTreatmentRegistry,
} from "./treatment-registry.mjs";
import { computeTranscriptIdentity } from "./youtube-transcript-core.mjs";

const seedPackages = (ledger, count = 1) => {
  ledger.syncPlaylistVideos({
    playlistId: "playlist-1",
    packageVersion: "v1",
    videos: [
      { videoId: "video-1", title: "A video", url: "https://youtu.be/video-1" },
    ],
  });
  const job = ledger.getPackageJob("video-1", "v1");
  ledger.recordHeatmapSelection({
    jobId: job.id,
    heatmap: [],
    packages: Array.from({ length: count }, (_, index) => ({
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
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"));
  t.after(() => ledger.close());
  seedPackages(ledger);
  let acquisitions = 0;
  let renders = 0;
  const events = [];
  const dependencies = {
    onEvent: async (event) => { events.push(event); throw Error("logging unavailable"); },
    ledger,
    registry: createTreatmentRegistry([audiogramBasicTreatment]),
    treatments: [{ id: "audiogram-basic", version: "1" }],
    loadTranscriptForPackage: (packageId) =>
      ledger.getTranscriptForPackage(packageId),
    acquireAssets: async () => {
      acquisitions += 1;
      return [
        { role: "audio", relativePath: "public/audio.wav" },
        { role: "captions", relativePath: "public/captions.json" },
        { role: "thumbnail", relativePath: "public/thumbnail.jpg" },
      ];
    },
    renderTreatment: async () => {
      renders += 1;
      return "out/treatments/audiogram-basic/1/video-1/v1/clip-1.mp4";
    },
  };

  const first = await processClipPackages(dependencies);
  const second = await processClipPackages(dependencies);

  assert.equal(acquisitions, 1);
  assert.equal(renders, 1);
  assert.deepEqual(events.map(({ stage, status }) => [stage, status]), [["assets", "started"], ["assets", "completed"], ["render", "started"], ["render", "completed"]]);
  assert.deepEqual(first, {
    packages: { ready: 1, failed: 0 },
    treatments: { rendered: 1, failed: 0 },
  });
  assert.deepEqual(second, {
    packages: { ready: 0, failed: 0 },
    treatments: { rendered: 0, failed: 0 },
  });
});

test("a failed package does not prevent another package from rendering", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clip-processing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"));
  t.after(() => ledger.close());
  const packages = seedPackages(ledger, 2);

  const result = await processClipPackages({
    ledger,
    registry: createTreatmentRegistry([audiogramBasicTreatment]),
    treatments: [{ id: "audiogram-basic", version: "1" }],
    loadTranscriptForPackage: (packageId) =>
      ledger.getTranscriptForPackage(packageId),
    acquireAssets: async (clipPackage) => {
      if (clipPackage.rank === 1) throw new Error("caption download failed");
      return [
        { role: "audio", relativePath: "public/audio.wav" },
        { role: "captions", relativePath: "public/captions.json" },
        { role: "thumbnail", relativePath: "public/thumbnail.jpg" },
      ];
    },
    renderTreatment: async () => "out/clip-2.mp4",
  });

  assert.deepEqual(result, {
    packages: { ready: 1, failed: 1 },
    treatments: { rendered: 1, failed: 0 },
  });
  assert.equal(ledger.getClipPackage(packages[0].id).status, "failed");
  assert.equal(ledger.getClipPackage(packages[1].id).status, "ready");
  assert.equal(ledger.listTreatmentRuns(packages[1].id)[0].status, "rendered");
});

test("a render failure leaves the reusable package ready", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "clip-processing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"));
  t.after(() => ledger.close());
  const [clipPackage] = seedPackages(ledger);

  const result = await processClipPackages({
    ledger,
    registry: createTreatmentRegistry([audiogramBasicTreatment]),
    treatments: [{ id: "audiogram-basic", version: "1" }],
    loadTranscriptForPackage: (packageId) =>
      ledger.getTranscriptForPackage(packageId),
    acquireAssets: async () => [
      { role: "audio", relativePath: "public/audio.wav" },
      { role: "captions", relativePath: "public/captions.json" },
      { role: "thumbnail", relativePath: "public/thumbnail.jpg" },
    ],
    renderTreatment: async () => {
      throw new Error("browser failed");
    },
  });

  assert.deepEqual(result, {
    packages: { ready: 1, failed: 0 },
    treatments: { rendered: 0, failed: 1 },
  });
  assert.equal(ledger.getClipPackage(clipPackage.id).status, "ready");
  assert.equal(ledger.listTreatmentRuns(clipPackage.id)[0].status, "failed");
});

test("reopens persisted transcript selections and reuses one transcript for partial package acquisition", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "clip-processing-transcript-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledgerPath = join(directory, "ledger.sqlite");
  const projectRoot = join(directory, "project");
  const selectionRecipe = buildSelectionRecipe({
    selectorId: "transcript-llm",
    providerId: "openai-api",
    desiredClipCount: 3,
  });
  const expectedTranscriptSha256 = (() => {
    const cues = Array.from({ length: 12 }, (_, index) => ({
      id: `c${String(index + 1).padStart(6, "0")}`,
      startMs: index * 10_000,
      endMs: (index + 1) * 10_000,
      text: `Cue ${index + 1} persisted words`,
    }));
    const transcript = {
      source: "youtube_creator",
      language: "en",
      cues,
    };
    Object.assign(transcript, computeTranscriptIdentity(transcript));
    const ledger = openAudiogramLedger(ledgerPath, { selectionRecipe });
    ledger.syncPlaylistVideos({
      playlistId: "playlist-1",
      packageVersion: "transcript-v1",
      selectionRecipe,
      videos: [
        {
          videoId: "video-1",
          title: "A transcript video",
          url: "https://youtu.be/video-1",
        },
      ],
    });
    const job = ledger.getPackageJob("video-1", "transcript-v1");
    ledger.recordTranscriptSelection({
      jobId: job.id,
      transcript,
      result: { clips: [{ rank: 1 }, { rank: 2 }, { rank: 3 }] },
      packages: [
        { rank: 1, startMs: 0, endMs: 30_000, score: 0.9 },
        { rank: 2, startMs: 45_000, endMs: 75_000, score: 0.8 },
        { rank: 3, startMs: 90_000, endMs: 120_000, score: 0.7 },
      ],
      provenance: {
        providerId: "openai-api",
        model: selectionRecipe.recipe.provider.model,
        recipeSha256: selectionRecipe.sha256,
      },
      selectionRecipe,
    });
    const sha256 = transcript.sha256;
    ledger.close();
    return sha256;
  })();

  const ledger = openAudiogramLedger(ledgerPath, { selectionRecipe });
  t.after(() => ledger.close());
  const commands = [];
  const runCommand = async (command, args) => {
    commands.push({ command, args });
    if (command === "ffprobe") return { stdout: "30\n" };
    const outputTemplate = args[args.indexOf("--output") + 1];
    await mkdir(dirname(outputTemplate), { recursive: true });
    if (args.includes("--extract-audio")) {
      await writeFile(outputTemplate.replace("%(ext)s", "wav"), "audio");
    } else if (args.includes("--write-thumbnail")) {
      await writeFile(outputTemplate.replace("%(ext)s", "jpg"), "image");
    }
    return { stdout: "" };
  };
  let transcriptLoads = 0;
  let renders = 0;
  const acquiredTranscripts = [];
  const dependencies = {
    ledger,
    registry: createTreatmentRegistry([audiogramBasicTreatment]),
    treatments: [{ id: "audiogram-basic", version: "1" }],
    loadTranscriptForPackage: (packageId) => {
      transcriptLoads += 1;
      return ledger.getTranscriptForPackage(packageId);
    },
    acquireAssets: async (clipPackage) => {
      acquiredTranscripts.push(clipPackage.transcript);
      return acquireClipPackageAssets(clipPackage, {
        projectRoot,
        runCommand,
        createStagingId: () => `package-${clipPackage.rank}`,
      });
    },
    renderTreatment: async ({ clipPackage }) => {
      renders += 1;
      return `out/clip-${clipPackage.rank}.mp4`;
    },
  };

  const first = await processClipPackages(dependencies);

  assert.deepEqual(first, {
    packages: { ready: 3, failed: 0 },
    treatments: { rendered: 3, failed: 0 },
  });
  assert.equal(transcriptLoads, 3);
  assert.equal(acquiredTranscripts.length, 3);
  assert.ok(
    acquiredTranscripts.every((value) => value === acquiredTranscripts[0]),
  );
  assert.equal(acquiredTranscripts[0].sha256, expectedTranscriptSha256);
  assert.equal(
    commands.filter(({ args }) =>
      args.some((argument) =>
        ["--write-subs", "--write-auto-subs"].includes(argument),
      ),
    ).length,
    0,
  );
  assert.equal(
    commands.filter(({ args }) => args.includes("--download-sections")).length,
    3,
  );
  assert.ok(
    commands
      .filter(({ command }) => command === "yt-dlp")
      .every(
        ({ args }) =>
          args.includes("--skip-download") ||
          args.includes("--download-sections"),
      ),
  );
  for (const rank of [1, 2, 3]) {
    const packageDirectory = join(
      projectRoot,
      "public",
      "generated",
      "video-1",
      "transcript-v1",
      `clip-${rank}`,
    );
    const manifest = JSON.parse(
      await readFile(join(packageDirectory, "package.json"), "utf8"),
    );
    const captions = JSON.parse(
      await readFile(join(packageDirectory, "captions.json"), "utf8"),
    );
    assert.deepEqual(manifest.transcript, {
      id: acquiredTranscripts[0].id,
      sha256: expectedTranscriptSha256,
      source: "youtube_creator",
      language: "en",
    });
    assert.ok(captions.length > 0);
    assert.ok(
      captions.every(
        ({ startMs, endMs, timestampMs, confidence }) =>
          Number.isFinite(startMs) &&
          Number.isFinite(endMs) &&
          Number.isFinite(timestampMs) &&
          confidence === null,
      ),
    );
  }

  const beforeSecond = {
    commands: commands.length,
    renders,
    transcriptLoads,
  };
  const second = await processClipPackages(dependencies);
  assert.deepEqual(second, {
    packages: { ready: 0, failed: 0 },
    treatments: { rendered: 0, failed: 0 },
  });
  assert.deepEqual(
    { commands: commands.length, renders, transcriptLoads },
    beforeSecond,
  );
});

test('does not execute a different treatment pending for the same video',async(t)=>{
 const directory=await mkdtemp(join(tmpdir(),'selected-treatment-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const ledger=openAudiogramLedger(join(directory,'ledger.sqlite'));t.after(()=>ledger.close());
 const [pkg]=seedPackages(ledger);ledger.markPackageReady({packageId:pkg.id,assets:[]});
 const other=ledger.ensureTreatmentRun({packageId:pkg.id,treatmentId:'other',treatmentVersion:'1'});
 const first={...audiogramBasicTreatment,requiredAssetRoles:[]};
 const second={...first,id:'other'};
 const rendered=[];
 const result=await processClipPackages({ledger,registry:createTreatmentRegistry([first,second]),treatments:[{id:first.id,version:first.version}],videoId:'video-1',renderTreatment:async({treatment})=>{rendered.push(treatment.id);return `out/${treatment.id}.mp4`;}});
 assert.deepEqual(rendered,['audiogram-basic']);assert.equal(result.treatments.rendered,1);
 assert.equal(ledger.listPendingTreatmentRuns().some(run=>run.id===other.id),true);
});
