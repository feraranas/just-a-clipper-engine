import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openAudiogramLedger } from "./audiogram-ledger.mjs";
import { buildSelectionRecipe } from "./clip-selection-contract.mjs";
import { syncAndAnalyzeInbox } from "./youtube-inbox-pipeline-core.mjs";
import { resolveSelectionConfig } from "./youtube-pipeline-config.mjs";
import { computeTranscriptIdentity } from "./youtube-transcript-core.mjs";

const heatmapConfig = resolveSelectionConfig({});
const heatmapRecipe = buildSelectionRecipe(heatmapConfig);
const transcriptConfig = resolveSelectionConfig({
  AUDIOGRAM_CLIP_SELECTOR: "transcript-llm",
  AUDIOGRAM_LLM_PROVIDER: "openai-api",
  AUDIOGRAM_TRANSCRIPT_CLIP_COUNT: "3",
  OPENAI_API_KEY: "test-key",
});
const transcriptRecipe = buildSelectionRecipe(transcriptConfig);

const exampleTranscript = (label = "video") => {
  const transcript = {
    source: "youtube_creator",
    language: "en",
    cues: Array.from({ length: 13 }, (_, index) => ({
      id: `c${String(index + 1).padStart(6, "0")}`,
      startMs: index * 10_000,
      endMs: (index + 1) * 10_000,
      text: `${label} cue ${index + 1} grounded transcript text`,
    })),
  };
  return { ...transcript, ...computeTranscriptIdentity(transcript) };
};

const validParsedSelection = {
  clips: [
    [1, "first-idea", "c000001", "c000002", "c000003"],
    [2, "second-idea", "c000006", "c000007", "c000008"],
    [3, "third-idea", "c000011", "c000012", "c000013"],
  ].map(([rank, ideaKey, contextCueId, insightCueId, payoffCueId]) => ({
    rank,
    title: `A complete useful idea ${rank}`,
    ideaKey,
    startCueId: contextCueId,
    contextCueId,
    insightCueId,
    payoffCueId,
    endCueId: payoffCueId,
    contextSummary: "Enough setup for the useful central claim",
    insightSummary: "The central claim contains a useful insight",
    payoffSummary: "The consequence completes the useful thought",
    score: 1 - rank / 10,
    editorialChecks: {
      selfContained: true,
      hasSetupBeforeClaim: true,
      completeThought: true,
      substantiveInsight: true,
      containsSponsorOrCta: false,
    },
  })),
};

test("a completed video is not analyzed again on the next playlist sync", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-pipeline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"));
  t.after(() => ledger.close());

  const playlist = { id: "playlist-1", title: "Audiogram Inbox" };
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
      heatmap: [{ start_time: 20, end_time: 40, value: 0.9 }],
    };
  };

  const first = await syncAndAnalyzeInbox({
    fetchMetadata,
    ledger,
    playlist,
    selectionConfig: heatmapConfig,
    selectionRecipe: heatmapRecipe,
    videos,
  });
  const second = await syncAndAnalyzeInbox({
    fetchMetadata,
    ledger,
    playlist,
    selectionConfig: heatmapConfig,
    selectionRecipe: heatmapRecipe,
    videos,
  });

  assert.equal(metadataRequests, 1);
  assert.deepEqual(first.sync, { discovered: 1, existing: 0 });
  assert.equal(first.analyzed[0].status, "selection_ready");
  assert.deepEqual(second.sync, { discovered: 0, existing: 1 });
  assert.deepEqual(second.analyzed, []);
});

test("a video without a heatmap receives a terminal status", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-pipeline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"));
  t.after(() => ledger.close());

  const result = await syncAndAnalyzeInbox({
    fetchMetadata: async () => ({}),
    ledger,
    playlist: { id: "playlist-1", title: "Audiogram Inbox" },
    selectionConfig: heatmapConfig,
    selectionRecipe: heatmapRecipe,
    videos: [
      {
        videoId: "video-1",
        title: "A video",
        url: "https://www.youtube.com/watch?v=video-1",
      },
    ],
  });

  assert.equal(result.analyzed[0].status, "no_selection");
  assert.equal(ledger.getPackageJob("video-1", "v1").status, "no_selection");
  assert.deepEqual(ledger.listPendingPackageJobs(), []);
});

test("heatmap selection never constructs a provider or loads a transcript", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-pipeline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"), {
    selectionRecipe: heatmapRecipe,
  });
  t.after(() => ledger.close());
  let providerConstructions = 0;
  let transcriptLoads = 0;

  const result = await syncAndAnalyzeInbox({
    ledger,
    playlist: { id: "playlist-1", title: "Audiogram Inbox" },
    selectionConfig: heatmapConfig,
    selectionRecipe: heatmapRecipe,
    videos: [
      {
        videoId: "video-1",
        title: "A video",
        url: "https://youtu.be/video-1",
      },
    ],
    fetchMetadata: async () => ({
      heatmap: [{ start_time: 20, end_time: 40, value: 0.9 }],
    }),
    fetchTranscript: async () => {
      transcriptLoads += 1;
      throw new Error("transcript loader should not run");
    },
    createProvider: () => {
      providerConstructions += 1;
      throw new Error("provider should not be constructed");
    },
  });

  assert.equal(result.analyzed[0].status, "selection_ready");
  assert.equal(providerConstructions, 0);
  assert.equal(transcriptLoads, 0);
});

test("transcript selection never requests heatmap metadata and records derived clips", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-pipeline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"), {
    selectionRecipe: transcriptRecipe,
  });
  t.after(() => ledger.close());
  let heatmapRequests = 0;
  let providerConstructions = 0;
  let providerRequests = 0;
  let transcriptLoads = 0;

  const dependencies = {
    ledger,
    playlist: { id: "playlist-1", title: "Audiogram Inbox" },
    selectionConfig: transcriptConfig,
    selectionRecipe: transcriptRecipe,
    videos: [
      {
        videoId: "video-1",
        title: "A video",
        url: "https://youtu.be/video-1",
      },
    ],
    fetchMetadata: async () => {
      heatmapRequests += 1;
      throw new Error("heatmap loader should not run");
    },
    fetchTranscript: async () => {
      transcriptLoads += 1;
      return exampleTranscript();
    },
    createProvider: () => {
      providerConstructions += 1;
      return {
        generateStructured: async () => {
          providerRequests += 1;
          return {
            parsed: validParsedSelection,
            provenance: {
              providerId: "openai-api",
              model: transcriptRecipe.recipe.provider.model,
              recipeSha256: transcriptRecipe.sha256,
            },
          };
        },
      };
    },
  };
  const result = await syncAndAnalyzeInbox(dependencies);

  assert.equal(heatmapRequests, 0);
  assert.equal(providerConstructions, 1);
  assert.equal(providerRequests, 1);
  assert.equal(transcriptLoads, 1);
  assert.equal(result.analyzed[0].status, "selection_ready");
  assert.equal(
    ledger.getPackageJob("video-1", transcriptConfig.packageVersion).status,
    "selection_ready",
  );
  assert.equal(
    ledger.listClipPackages(
      ledger.getPackageJob("video-1", transcriptConfig.packageVersion).id,
    ).length,
    3,
  );

  const second = await syncAndAnalyzeInbox(dependencies);
  assert.deepEqual(second.analyzed, []);
  assert.deepEqual(
    {
      heatmapRequests,
      providerConstructions,
      providerRequests,
      transcriptLoads,
    },
    {
      heatmapRequests: 0,
      providerConstructions: 1,
      providerRequests: 1,
      transcriptLoads: 1,
    },
  );
});

for (const failure of ["acquisition", "provider", "schema", "semantic"]) {
  test(`a transcript ${failure} failure marks only its job failed without fallback`, async () => {
    const events = [];
    const failedJobs = [];
    const recordedJobs = [];
    let heatmapRequests = 0;
    let providerConstructions = 0;
    let providerRequests = 0;
    const ledger = {
      syncPlaylistVideos: () => ({ discovered: 2, existing: 0 }),
      listPendingPackageJobs: () => [
        {
          id: 1,
          videoId: "video-1",
          title: "First",
          sourceUrl: "https://youtu.be/video-1",
          packageVersion: transcriptConfig.packageVersion,
        },
        {
          id: 2,
          videoId: "video-2",
          title: "Second",
          sourceUrl: "https://youtu.be/video-2",
          packageVersion: transcriptConfig.packageVersion,
        },
      ],
      markPackageJobFailed: (jobId) => failedJobs.push(jobId),
      recordTranscriptSelection: ({ jobId }) => recordedJobs.push(jobId),
    };

    const result = await syncAndAnalyzeInbox({
      onEvent: (event) => events.push(event),
      ledger,
      playlist: { id: "playlist-1", title: "Audiogram Inbox" },
      selectionConfig: transcriptConfig,
      selectionRecipe: transcriptRecipe,
      videos: [
        {
          videoId: "video-1",
          title: "First",
          url: "https://youtu.be/video-1",
        },
        {
          videoId: "video-2",
          title: "Second",
          url: "https://youtu.be/video-2",
        },
      ],
      fetchMetadata: async () => {
        heatmapRequests += 1;
        throw new Error("heatmap loader should not run");
      },
      fetchTranscript: async (sourceUrl) => {
        if (failure === "acquisition" && sourceUrl.endsWith("video-1")) {
          throw new Error("transcript acquisition failed");
        }
        return exampleTranscript(
          sourceUrl.endsWith("video-1") ? "first" : "second",
        );
      },
      createProvider: () => {
        providerConstructions += 1;
        return {
          generateStructured: async ({ input }) => {
            providerRequests += 1;
            if (input.includes("first cue")) {
              if (failure === "provider") throw new Error("provider failed");
              if (failure === "schema") throw new Error("schema rejected");
              if (failure === "semantic") {
                return {
                  parsed: {
                    ...validParsedSelection,
                    clips: validParsedSelection.clips.map((clip, index) =>
                      index === 0 ? { ...clip, insightCueId: "c999999" } : clip,
                    ),
                  },
                  provenance: {
                    providerId: "openai-api",
                    model: transcriptRecipe.recipe.provider.model,
                    recipeSha256: transcriptRecipe.sha256,
                  },
                };
              }
            }
            return {
              parsed: validParsedSelection,
              provenance: {
                providerId: "openai-api",
                model: transcriptRecipe.recipe.provider.model,
                recipeSha256: transcriptRecipe.sha256,
              },
            };
          },
        };
      },
    });

    assert.deepEqual(failedJobs, [1]);
    const failedStep = failure === "acquisition" ? "transcript" : "selection";
    assert.deepEqual(events.filter((event) => event.videoId === "video-1" && event.stage === failedStep).map((event) => event.status), ["started", "failed"]);
    assert.deepEqual(recordedJobs, [2]);
    assert.deepEqual(
      result.analyzed.map(({ videoId, status }) => ({ videoId, status })),
      [
        { videoId: "video-1", status: "failed" },
        { videoId: "video-2", status: "selection_ready" },
      ],
    );
    assert.equal(heatmapRequests, 0);
    assert.equal(providerConstructions, 1);
    assert.equal(providerRequests, failure === "acquisition" ? 1 : 2);
  });
}
