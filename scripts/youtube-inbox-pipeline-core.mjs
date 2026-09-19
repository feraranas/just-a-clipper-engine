import {
  extractHeatmap,
  fetchYtDlpMetadata,
  selectTopHeatmapClips,
} from "./youtube-heatmap-core.mjs";

export const syncAndAnalyzeInbox = async ({
  ledger,
  playlist,
  videos,
  packageVersion,
  maxClips = 1,
  minimumSeparationSeconds = 20,
  fetchMetadata = fetchYtDlpMetadata,
}) => {
  const sync = ledger.syncPlaylistVideos({
    playlistId: playlist.id,
    packageVersion,
    videos,
  });
  const currentVideoIds = new Set(videos.map(({videoId}) => videoId));
  const pendingJobs = ledger
    .listPendingPackageJobs()
    .filter(
      (job) =>
        job.packageVersion === packageVersion &&
        currentVideoIds.has(job.videoId),
    );
  const analyzed = [];

  for (const job of pendingJobs) {
    try {
      const metadata = await fetchMetadata(job.sourceUrl);
      const heatmap = extractHeatmap(metadata);
      const packages = selectTopHeatmapClips(heatmap, {
        maxClips,
        minimumSeparationSeconds,
      });

      ledger.recordHeatmapSelection({jobId: job.id, heatmap, packages});
      analyzed.push({
        videoId: job.videoId,
        title: job.title,
        status: packages.length > 0 ? "heatmap_ready" : "no_heatmap",
        packages,
      });
    } catch (error) {
      ledger.markPackageJobFailed(
        job.id,
        error instanceof Error ? error.message : error,
      );
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
