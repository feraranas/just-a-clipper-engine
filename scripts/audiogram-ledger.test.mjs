import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {openAudiogramLedger} from "./audiogram-ledger.mjs";

test("playlist sync is idempotent and preserves completed processing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, {recursive: true, force: true}));

  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"), {
    now: () => "2026-09-16T12:00:00.000Z",
  });
  t.after(() => ledger.close());

  const firstSync = ledger.syncPlaylistVideos({
    playlistId: "playlist-1",
    treatmentVersion: "v1",
    videos: [
      {
        videoId: "video-1",
        title: "Original title",
        url: "https://www.youtube.com/watch?v=video-1",
      },
    ],
  });

  assert.deepEqual(firstSync, {discovered: 1, existing: 0});
  const job = ledger.getProcessingJob("video-1", "v1");
  assert.equal(job.status, "discovered");

  ledger.recordHeatmapSelection({
    jobId: job.id,
    heatmap: [{startTime: 10, endTime: 30, value: 0.9}],
    clips: [{rank: 1, startSeconds: 10, endSeconds: 30, score: 0.9}],
  });

  const secondSync = ledger.syncPlaylistVideos({
    playlistId: "playlist-1",
    treatmentVersion: "v1",
    videos: [
      {
        videoId: "video-1",
        title: "Updated title",
        url: "https://www.youtube.com/watch?v=video-1",
      },
    ],
  });

  assert.deepEqual(secondSync, {discovered: 0, existing: 1});
  assert.equal(ledger.getVideo("video-1").title, "Updated title");
  assert.equal(ledger.getProcessingJob("video-1", "v1").status, "heatmap_ready");
  assert.deepEqual(ledger.listClips(job.id), [
    {
      id: 1,
      processingJobId: job.id,
      rank: 1,
      startSeconds: 10,
      endSeconds: 30,
      score: 0.9,
      status: "selected",
      artifactRelativePath: null,
    },
  ]);
  assert.deepEqual(ledger.listPendingJobs(), []);
});

test("a new treatment version creates a new job without duplicating the video", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, {recursive: true, force: true}));

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

  ledger.syncPlaylistVideos({...input, treatmentVersion: "v1"});
  ledger.syncPlaylistVideos({...input, treatmentVersion: "v2"});

  assert.equal(ledger.countVideos(), 1);
  assert.equal(ledger.countProcessingJobs(), 2);
});

test("a job can retain multiple ranked clips", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, {recursive: true, force: true}));

  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"));
  t.after(() => ledger.close());

  ledger.syncPlaylistVideos({
    playlistId: "playlist-1",
    treatmentVersion: "v1",
    videos: [
      {
        videoId: "video-1",
        title: "A video",
        url: "https://www.youtube.com/watch?v=video-1",
      },
    ],
  });
  const job = ledger.getProcessingJob("video-1", "v1");

  ledger.recordHeatmapSelection({
    jobId: job.id,
    heatmap: [],
    clips: [
      {rank: 1, startSeconds: 10, endSeconds: 30, score: 0.9},
      {rank: 2, startSeconds: 90, endSeconds: 110, score: 0.7},
    ],
  });

  assert.deepEqual(
    ledger.listClips(job.id).map(({rank, startSeconds, endSeconds}) => ({
      rank,
      startSeconds,
      endSeconds,
    })),
    [
      {rank: 1, startSeconds: 10, endSeconds: 30},
      {rank: 2, startSeconds: 90, endSeconds: 110},
    ],
  );
});

