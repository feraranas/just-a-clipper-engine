import {
  extractHeatmap,
  fetchYtDlpMetadata,
  selectTopHeatmapClips,
} from "./youtube-heatmap-core.mjs";
import { sanitizeErrorDiagnostic } from "./error-diagnostics.mjs";
import { buildTranscriptJsonSchema } from "./clip-selection-contract.mjs";
import { createStructuredGenerationProvider } from "./structured-generation-provider.mjs";
import {
  buildTranscriptPrompt,
  deriveClipSelections,
} from "./transcript-selector.mjs";
import { fetchYoutubeTranscript } from "./youtube-transcript-core.mjs";

export const syncAndAnalyzeInbox = async ({
  ledger,
  playlist,
  videos,
  selectionConfig,
  selectionRecipe,
  fetchMetadata = fetchYtDlpMetadata,
  fetchTranscript = fetchYoutubeTranscript,
  createProvider = createStructuredGenerationProvider,
}) => {
  const { packageVersion, selectorId } = selectionConfig;
  const sync = ledger.syncPlaylistVideos({
    playlistId: playlist.id,
    packageVersion,
    selectionRecipe,
    videos,
  });
  const currentVideoIds = new Set(videos.map(({ videoId }) => videoId));
  const pendingJobs = ledger
    .listPendingPackageJobs()
    .filter(
      (job) =>
        job.packageVersion === packageVersion &&
        currentVideoIds.has(job.videoId),
    );
  const analyzed = [];
  let provider;

  for (const job of pendingJobs) {
    try {
      let packages;
      if (selectorId === "youtube-heatmap") {
        const metadata = await fetchMetadata(job.sourceUrl);
        const heatmap = extractHeatmap(metadata);
        packages = selectTopHeatmapClips(heatmap, {
          maxClips: selectionConfig.maxClips,
          minimumSeparationSeconds: selectionConfig.minimumSeparationMs / 1_000,
        });

        ledger.recordHeatmapSelection({
          jobId: job.id,
          heatmap,
          packages,
          selectionRecipe,
        });
      } else if (selectorId === "transcript-llm") {
        const transcript = await fetchTranscript(job.sourceUrl);
        ledger.persistTranscript?.({ videoId: job.videoId, transcript });
        provider ??= createProvider(selectionConfig);
        const prompt = buildTranscriptPrompt(transcript);
        const generated = await provider.generateStructured({
          instructions: prompt.instructions,
          input: prompt.input,
          jsonSchema: buildTranscriptJsonSchema(
            selectionConfig.desiredClipCount,
          ),
        });
        packages = deriveClipSelections(
          generated.parsed,
          transcript,
          selectionRecipe.recipe,
        );
        ledger.recordTranscriptSelection({
          jobId: job.id,
          transcript,
          result: generated.parsed,
          packages,
          provenance: generated.provenance,
          selectionRecipe,
        });
      } else {
        throw new Error("Unsupported clip selector or version");
      }
      analyzed.push({
        videoId: job.videoId,
        title: job.title,
        status: packages.length > 0 ? "selection_ready" : "no_selection",
        packages,
      });
    } catch (error) {
      ledger.markPackageJobFailed(job.id, sanitizeErrorDiagnostic(error));
      analyzed.push({
        videoId: job.videoId,
        title: job.title,
        status: "failed",
        error: sanitizeErrorDiagnostic(error),
      });
    }
  }

  return { sync, analyzed };
};
