import {
  extractHeatmap,
  fetchYtDlpMetadata,
  selectTopHeatmapClips,
} from "./youtube-heatmap-core.mjs";
import {
  sanitizeErrorDiagnostic,
  SafeDiagnosticError,
} from "./error-diagnostics.mjs";
import {
  buildTranscriptJsonSchema,
  MAXIMUM_SELECTION_ATTEMPTS,
} from "./clip-selection-contract.mjs";
import { createStructuredGenerationProvider } from "./structured-generation-provider.mjs";
import {
  buildTranscriptPrompt,
  deriveClipSelections,
} from "./transcript-selector.mjs";
import { fetchYoutubeTranscript } from "./youtube-transcript-core.mjs";
import { rankTranscriptPackagesWithJev } from "./jev-transcript-ranking.mjs";
import { QUESTION_DEFINITIONS } from "./question-analysis-contract.mjs";
import { emitPipelineEvent, runLoggedStage } from "./pipeline-logger.mjs";

export const syncAndAnalyzeInbox = async ({
  ledger,
  playlist,
  videos,
  selectionConfig,
  selectionRecipe,
  fetchMetadata = fetchYtDlpMetadata,
  fetchTranscript = fetchYoutubeTranscript,
  createProvider = createStructuredGenerationProvider,
  jevClient,
  onEvent,
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
  await emitPipelineEvent(onEvent, {
    stage: "videos-pending",
    status: "completed",
    count: pendingJobs.length,
  });

  for (const job of pendingJobs) {
    let activeStage =
      selectorId === "transcript-llm" ? "transcript" : "selection";
    const step = (stage, operation) => {
      activeStage = stage;
      return runLoggedStage({
        logger: { event: onEvent },
        stage,
        videoId: job.videoId,
        operation,
      });
    };
    try {
      let packages;
      if (selectorId === "youtube-heatmap") {
        const metadata = await step("heatmap", () =>
          fetchMetadata(job.sourceUrl),
        );
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
        const transcript = await step("transcript", () =>
          fetchTranscript(job.sourceUrl),
        );
        ledger.persistTranscript?.({ videoId: job.videoId, transcript });
        provider ??= createProvider(selectionConfig);
        const prompt = buildTranscriptPrompt(transcript);
        let generated;
        packages = await step("selection", async () => {
          let input = prompt.input;
          for (
            let attempt = 1;
            attempt <= MAXIMUM_SELECTION_ATTEMPTS;
            attempt += 1
          ) {
            let validatingClips = false;
            try {
              generated = await provider.generateStructured({
                instructions: prompt.instructions,
                input,
                jsonSchema: buildTranscriptJsonSchema(
                  selectionConfig.desiredClipCount,
                ),
              });
              validatingClips = true;
              return deriveClipSelections(
                generated.parsed,
                transcript,
                selectionRecipe.recipe,
              );
            } catch (error) {
              if (
                !validatingClips &&
                !(
                  error instanceof SafeDiagnosticError &&
                  error.code === "selection_output_invalid"
                )
              )
                throw error;
              if (attempt === MAXIMUM_SELECTION_ATTEMPTS) throw error;
              const code =
                error?.code === "SELECTION_INVALID_CUE"
                  ? "SELECTION_INVALID_CUE"
                  : "SELECTION_INVALID_OUTPUT";
              await emitPipelineEvent(onEvent, {
                stage: "selection",
                status: "retrying",
                videoId: job.videoId,
                count: attempt + 1,
                errorCode: code,
              });
              input = JSON.stringify({
                ...JSON.parse(prompt.input),
                validationFeedback: {
                  code,
                  instruction:
                    "The previous selection failed validation. Select again using only the supplied cue IDs. Check evidence order, distinct ideas, clip duration, separation, and editorial requirements. Do not fabricate cues.",
                },
              });
            }
          }
        });
        if (jevClient) {
          packages = await step("jev", () =>
            rankTranscriptPackagesWithJev({
              transcript,
              packages,
              questions: QUESTION_DEFINITIONS,
              jevClient,
            }),
          );
        } else {
          await emitPipelineEvent(onEvent, {
            stage: "jev",
            status: "skipped",
            videoId: job.videoId,
          });
        }
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
      await emitPipelineEvent(onEvent, {
        stage: "video-analysis",
        status: "completed",
        videoId: job.videoId,
        count: packages.length,
      });
    } catch (error) {
      await emitPipelineEvent(onEvent, {
        stage: "video-analysis",
        status: "failed",
        videoId: job.videoId,
        errorCode: "analysis_failed",
      });
      ledger.markPackageJobFailed(job.id, sanitizeErrorDiagnostic(error));
      analyzed.push({
        videoId: job.videoId,
        title: job.title,
        status: "failed",
        error: sanitizeErrorDiagnostic(error),
        failure: {
          stage: activeStage,
          code:
            activeStage === "selection" &&
            error?.code === "SELECTION_INVALID_CUE"
              ? "SELECTION_INVALID_CUE"
              : ({
                  transcript: "TRANSCRIPT_FAILED",
                  selection: "SELECTION_FAILED",
                  jev: "JEV_FAILED",
                  heatmap: "SELECTION_FAILED",
                }[activeStage] ?? "ANALYSIS_FAILED"),
        },
      });
    }
  }

  return { sync, analyzed };
};
