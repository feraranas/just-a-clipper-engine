import {
  extractHeatmap,
  fetchYtDlpMetadata,
  selectTopHeatmapClips,
} from "./youtube-heatmap-core.mjs";

export const syncAndAnalyzeInbox = async ({
  ledger,
  playlist,
  videos,
  treatmentVersion,
  maxClips = 1,
  minimumSeparationSeconds = 20,
  fetchMetadata = fetchYtDlpMetadata,
}) => {
  const sync = ledger.syncPlaylistVideos({
    playlistId: playlist.id,
    treatmentVersion,
    videos,
  });
  const currentVideoIds = new Set(videos.map(({videoId}) => videoId));
  const pendingJobs = ledger
    .listPendingJobs()
    .filter(
      (job) =>
        job.treatmentVersion === treatmentVersion &&
        currentVideoIds.has(job.videoId),
    );
  const analyzed = [];

  for (const job of pendingJobs) {
    try {
      const metadata = await fetchMetadata(job.sourceUrl);
      const heatmap = extractHeatmap(metadata);
      const clips = selectTopHeatmapClips(heatmap, {
        maxClips,
        minimumSeparationSeconds,
      });

      ledger.recordHeatmapSelection({jobId: job.id, heatmap, clips});
      analyzed.push({
        videoId: job.videoId,
        title: job.title,
        status: clips.length > 0 ? "heatmap_ready" : "no_heatmap",
        clips,
      });
    } catch (error) {
      ledger.markJobFailed(job.id, error instanceof Error ? error.message : error);
      analyzed.push({
        videoId: job.videoId,
        title: job.title,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {sync, analyzed};
};

