import assert from "node:assert/strict";
import test from "node:test";

import {
  extractHeatmap,
  fetchYtDlpMetadata,
  selectTopHeatmapClips,
} from "./youtube-heatmap-core.mjs";

test("extractHeatmap normalizes valid yt-dlp markers", () => {
  assert.deepEqual(
    extractHeatmap({
      heatmap: [
        { start_time: 0, end_time: 20, value: 0.2 },
        { start_time: 20, end_time: 40, value: 0.9 },
        { start_time: "bad", end_time: 60, value: 0.5 },
      ],
    }),
    [
      { startTime: 0, endTime: 20, value: 0.2 },
      { startTime: 20, endTime: 40, value: 0.9 },
    ],
  );
});

test("selectTopHeatmapClips ranks independent peaks and supports multiple clips", () => {
  const clips = selectTopHeatmapClips(
    [
      { startTime: 0, endTime: 20, value: 0.1 },
      { startTime: 20, endTime: 40, value: 0.9 },
      { startTime: 40, endTime: 60, value: 0.8 },
      { startTime: 60, endTime: 80, value: 0.2 },
      { startTime: 100, endTime: 120, value: 0.7 },
    ],
    { maxClips: 2, minimumSeparationSeconds: 20 },
  );

  assert.deepEqual(clips, [
    { rank: 1, startSeconds: 20, endSeconds: 40, score: 0.9 },
    { rank: 2, startSeconds: 100, endSeconds: 120, score: 0.7 },
  ]);
});

test("fetchYtDlpMetadata simulates extraction without downloading media", async () => {
  let invocation;
  const metadata = await fetchYtDlpMetadata(
    "https://www.youtube.com/watch?v=video-1",
    {
      run: async (command, args, options) => {
        invocation = { command, args, options };
        return { stdout: JSON.stringify({ id: "video-1", heatmap: [] }) };
      },
    },
  );

  assert.equal(metadata.id, "video-1");
  assert.equal(invocation.command, "yt-dlp");
  assert.ok(invocation.args.includes("--skip-download"));
  assert.ok(invocation.args.includes("--dump-single-json"));
  assert.ok(invocation.args.includes("--no-playlist"));
  assert.equal(
    invocation.args.at(-1),
    "https://www.youtube.com/watch?v=video-1",
  );
});
