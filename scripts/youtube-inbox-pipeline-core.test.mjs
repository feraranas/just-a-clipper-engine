import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {openAudiogramLedger} from "./audiogram-ledger.mjs";
import {syncAndAnalyzeInbox} from "./youtube-inbox-pipeline-core.mjs";

test("a completed video is not analyzed again on the next playlist sync", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-pipeline-"));
  t.after(() => rm(directory, {recursive: true, force: true}));

  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"));
  t.after(() => ledger.close());

  const playlist = {id: "playlist-1", title: "Audiogram Inbox"};
  const videos = [
    {
      videoId: "video-1",
      title: "A video",
      url: "https://www.youtube.com/watch?v=video-1",
    },
  ];
  let metadataRequests = 0;
  const fetchMetadata = async () => {
    metadataRequests += 1;
    return {
      heatmap: [{start_time: 20, end_time: 40, value: 0.9}],
    };
  };

  const first = await syncAndAnalyzeInbox({
    fetchMetadata,
    ledger,
    playlist,
    packageVersion: "v1",
    videos,
  });
  const second = await syncAndAnalyzeInbox({
    fetchMetadata,
    ledger,
    playlist,
    packageVersion: "v1",
    videos,
  });

  assert.equal(metadataRequests, 1);
  assert.deepEqual(first.sync, {discovered: 1, existing: 0});
  assert.equal(first.analyzed[0].status, "heatmap_ready");
  assert.deepEqual(second.sync, {discovered: 0, existing: 1});
  assert.deepEqual(second.analyzed, []);
});

test("a video without a heatmap receives a terminal status", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-pipeline-"));
  t.after(() => rm(directory, {recursive: true, force: true}));

  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"));
  t.after(() => ledger.close());

  const result = await syncAndAnalyzeInbox({
    fetchMetadata: async () => ({}),
    ledger,
    playlist: {id: "playlist-1", title: "Audiogram Inbox"},
    packageVersion: "v1",
    videos: [
      {
        videoId: "video-1",
        title: "A video",
        url: "https://www.youtube.com/watch?v=video-1",
      },
    ],
  });

  assert.equal(result.analyzed[0].status, "no_heatmap");
  assert.equal(ledger.getPackageJob("video-1", "v1").status, "no_heatmap");
  assert.deepEqual(ledger.listPendingPackageJobs(), []);
});
