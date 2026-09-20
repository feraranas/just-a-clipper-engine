import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openAudiogramLedger } from "./audiogram-ledger.mjs";

test("migrates legacy processing records without data loss", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ledger.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE videos (
      video_id TEXT PRIMARY KEY, title TEXT NOT NULL, source_url TEXT NOT NULL,
      playlist_id TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE processing_jobs (
      id INTEGER PRIMARY KEY, video_id TEXT NOT NULL,
      treatment_version TEXT NOT NULL, status TEXT NOT NULL,
      heatmap_json TEXT, last_error TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, UNIQUE (video_id, treatment_version)
    ) STRICT;
    CREATE TABLE clips (
      id INTEGER PRIMARY KEY, processing_job_id INTEGER NOT NULL,
      rank INTEGER NOT NULL, start_seconds REAL NOT NULL,
      end_seconds REAL NOT NULL, score REAL NOT NULL, status TEXT NOT NULL,
      artifact_relative_path TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, UNIQUE (processing_job_id, rank)
    ) STRICT;
    INSERT INTO videos VALUES (
      'video-1', 'Legacy video', 'https://youtu.be/video-1', 'playlist-1',
      '2026-09-16T12:00:00.000Z', '2026-09-16T12:00:00.000Z'
    );
    INSERT INTO processing_jobs VALUES (
      1, 'video-1', 'v1', 'rendered', '[]', NULL,
      '2026-09-16T12:00:00.000Z', '2026-09-16T12:00:00.000Z'
    );
    INSERT INTO clips VALUES (
      1, 1, 1, 10.0, 30.0, 0.9, 'rendered',
      'out/legacy-video.mp4', '2026-09-16T12:00:00.000Z',
      '2026-09-16T12:00:00.000Z'
    );
  `);
  legacy.close();

  const ledger = openAudiogramLedger(path);
  t.after(() => ledger.close());

  const job = ledger.getPackageJob("video-1", "v1");
  assert.equal(job.status, "heatmap_ready");
  const [clipPackage] = ledger.listClipPackages(job.id);
  assert.equal(clipPackage.status, "ready");
  assert.deepEqual(ledger.listTreatmentRuns(clipPackage.id), [
    {
      id: 1,
      clipPackageId: clipPackage.id,
      treatmentId: "audiogram-basic",
      treatmentVersion: "1",
      status: "rendered",
      artifactRelativePath: "out/legacy-video.mp4",
      lastError: null,
      createdAt: "2026-09-16T12:00:00.000Z",
      updatedAt: "2026-09-16T12:00:00.000Z",
    },
  ]);
  assert.equal(ledger.countVideos(), 1);
  assert.equal(ledger.countPackageJobs(), 1);
});

test("playlist sync is idempotent and preserves completed packaging", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"), {
    now: () => "2026-09-16T12:00:00.000Z",
  });
  t.after(() => ledger.close());

  const firstSync = ledger.syncPlaylistVideos({
    playlistId: "playlist-1",
    packageVersion: "v1",
    videos: [
      {
        videoId: "video-1",
        title: "Original title",
        url: "https://www.youtube.com/watch?v=video-1",
      },
    ],
  });

  assert.deepEqual(firstSync, { discovered: 1, existing: 0 });
  const job = ledger.getPackageJob("video-1", "v1");
  assert.equal(job.status, "discovered");

  ledger.recordHeatmapSelection({
    jobId: job.id,
    heatmap: [{ startTime: 10, endTime: 30, value: 0.9 }],
    packages: [{ rank: 1, startSeconds: 10, endSeconds: 30, score: 0.9 }],
  });

  const secondSync = ledger.syncPlaylistVideos({
    playlistId: "playlist-1",
    packageVersion: "v1",
    videos: [
      {
        videoId: "video-1",
        title: "Updated title",
        url: "https://www.youtube.com/watch?v=video-1",
      },
    ],
  });

  assert.deepEqual(secondSync, { discovered: 0, existing: 1 });
  assert.equal(ledger.getVideo("video-1").title, "Updated title");
  assert.equal(ledger.getPackageJob("video-1", "v1").status, "heatmap_ready");
  assert.deepEqual(ledger.listClipPackages(job.id), [
    {
      id: 1,
      packageJobId: job.id,
      rank: 1,
      startSeconds: 10,
      endSeconds: 30,
      score: 0.9,
      status: "selected",
      lastError: null,
      createdAt: "2026-09-16T12:00:00.000Z",
      updatedAt: "2026-09-16T12:00:00.000Z",
    },
  ]);
  assert.deepEqual(ledger.listPendingPackageJobs(), []);
});

test("a new package version creates a new job without duplicating the video", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"));
  t.after(() => ledger.close());

  const input = {
    playlistId: "playlist-1",
    videos: [
      {
        videoId: "video-1",
        title: "A video",
        url: "https://www.youtube.com/watch?v=video-1",
      },
    ],
  };

  ledger.syncPlaylistVideos({ ...input, packageVersion: "v1" });
  ledger.syncPlaylistVideos({ ...input, packageVersion: "v2" });

  assert.equal(ledger.countVideos(), 1);
  assert.equal(ledger.countPackageJobs(), 2);
});

test("a job can retain multiple ranked clips", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"));
  t.after(() => ledger.close());

  ledger.syncPlaylistVideos({
    playlistId: "playlist-1",
    packageVersion: "v1",
    videos: [
      {
        videoId: "video-1",
        title: "A video",
        url: "https://www.youtube.com/watch?v=video-1",
      },
    ],
  });
  const job = ledger.getPackageJob("video-1", "v1");

  ledger.recordHeatmapSelection({
    jobId: job.id,
    heatmap: [],
    packages: [
      { rank: 1, startSeconds: 10, endSeconds: 30, score: 0.9 },
      { rank: 2, startSeconds: 90, endSeconds: 110, score: 0.7 },
    ],
  });

  assert.deepEqual(
    ledger
      .listClipPackages(job.id)
      .map(({ rank, startSeconds, endSeconds }) => ({
        rank,
        startSeconds,
        endSeconds,
      })),
    [
      { rank: 1, startSeconds: 10, endSeconds: 30 },
      { rank: 2, startSeconds: 90, endSeconds: 110 },
    ],
  );
});

test("ready packages retain typed assets and one idempotent treatment run", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"), {
    now: () => "2026-09-18T12:00:00.000Z",
  });
  t.after(() => ledger.close());

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
    packages: [{ rank: 1, startSeconds: 10, endSeconds: 30, score: 0.9 }],
  });
  const [clipPackage] = ledger.listClipPackages(job.id);
  const assets = [
    {
      role: "audio",
      relativePath: "public/generated/video-1/v1/clip-1/audio.wav",
    },
    {
      role: "captions",
      relativePath: "public/generated/video-1/v1/clip-1/captions.json",
    },
  ];

  ledger.markPackageReady({ packageId: clipPackage.id, assets });
  ledger.markPackageReady({ packageId: clipPackage.id, assets });
  const firstRun = ledger.ensureTreatmentRun({
    packageId: clipPackage.id,
    treatmentId: "audiogram-basic",
    treatmentVersion: "1",
  });
  const secondRun = ledger.ensureTreatmentRun({
    packageId: clipPackage.id,
    treatmentId: "audiogram-basic",
    treatmentVersion: "1",
  });

  assert.equal(firstRun.id, secondRun.id);
  assert.equal(ledger.listTreatmentRuns(clipPackage.id).length, 1);
  assert.deepEqual(
    ledger
      .getClipPackage(clipPackage.id)
      .assets.map(({ role, relativePath }) => ({
        role,
        relativePath,
      })),
    assets,
  );
  assert.equal(ledger.listSelectedPackages().length, 0);
  assert.equal(ledger.listPendingTreatmentRuns().length, 1);

  ledger.markTreatmentRunRendered(
    firstRun.id,
    "out/treatments/audiogram-basic/1/video-1/clip-1.mp4",
  );
  assert.equal(ledger.listPendingTreatmentRuns().length, 0);
  assert.equal(ledger.listTreatmentRuns(clipPackage.id)[0].status, "rendered");
});

test("package and treatment failures are isolated and retain their errors", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"));
  t.after(() => ledger.close());

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
    packages: [
      { rank: 1, startSeconds: 10, endSeconds: 30, score: 0.9 },
      { rank: 2, startSeconds: 40, endSeconds: 60, score: 0.8 },
    ],
  });
  const [failedPackage, readyPackage] = ledger.listClipPackages(job.id);
  ledger.markPackageFailed(failedPackage.id, "download failed");
  ledger.markPackageReady({ packageId: readyPackage.id, assets: [] });
  const run = ledger.ensureTreatmentRun({
    packageId: readyPackage.id,
    treatmentId: "audiogram-basic",
    treatmentVersion: "1",
  });
  ledger.markTreatmentRunFailed(run.id, "render failed");

  assert.equal(
    ledger.getClipPackage(failedPackage.id).lastError,
    "download failed",
  );
  assert.equal(ledger.getClipPackage(readyPackage.id).status, "ready");
  assert.equal(
    ledger.listTreatmentRuns(readyPackage.id)[0].lastError,
    "render failed",
  );

  const unsafeError = new Error(
    `--api-key secret-value ${"diagnostic".repeat(500)}`,
  );
  ledger.markPackageFailed(failedPackage.id, unsafeError);
  const persistedError = ledger.getClipPackage(failedPackage.id).lastError;
  assert.ok(persistedError.length <= 2_000);
  assert.doesNotMatch(persistedError, /secret-value/);
});
