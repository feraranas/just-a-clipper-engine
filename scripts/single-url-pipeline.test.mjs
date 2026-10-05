import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { openAudiogramLedger } from "./audiogram-ledger.mjs";
import { buildSelectionRecipe } from "./clip-selection-contract.mjs";
import { createPublishingLedger } from "./publishing-ledger.mjs";
import { runSingleUrlPipeline } from "./single-url-pipeline.mjs";
import { computeTranscriptIdentity } from "./youtube-transcript-core.mjs";

const videoId = "dQw4w9WgXcQ";
const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`;
const metadata = {
  id: videoId,
  title: "A source video",
};

const transcriptSource = {
  source: "youtube_creator",
  language: "en",
  cues: Array.from({ length: 15 }, (_, index) => {
    const group = Math.floor(index / 5);
    const withinGroup = index % 5;
    const startMs = group * 80_000 + withinGroup * 10_000;
    return {
      id: `c${String(index + 1).padStart(6, "0")}`,
      startMs,
      endMs: startMs + 10_000,
      text: `Transcript cue ${index + 1} gives grounded source evidence.`,
    };
  }),
};
const transcript = {
  ...transcriptSource,
  ...computeTranscriptIdentity(transcriptSource),
};
const transcriptSelection = {
  clips: [1, 2, 3].map((rank) => {
    const firstCue = (rank - 1) * 5 + 1;
    const cueId = (offset) => `c${String(firstCue + offset).padStart(6, "0")}`;
    return {
      rank,
      title: `A complete useful idea ${rank}`,
      ideaKey: `useful-idea-${rank}`,
      startCueId: cueId(0),
      contextCueId: cueId(1),
      insightCueId: cueId(2),
      payoffCueId: cueId(3),
      endCueId: cueId(4),
      contextSummary: "Provides setup for a new listener to understand the idea.",
      insightSummary: "States the substantive insight grounded in transcript cues.",
      payoffSummary: "Completes the thought with its practical consequence.",
      score: 1 - rank / 10,
      editorialChecks: {
        selfContained: true,
        hasSetupBeforeClaim: true,
        completeThought: true,
        substantiveInsight: true,
        containsSponsorOrCta: false,
      },
    };
  }),
};

const createOptions = async (directory, { media = metadata, transcriptError } = {}) => {
  const databaseDirectory = join(directory, "state");
  await mkdir(databaseDirectory, { recursive: true });
  const environment = {
    AUDIOGRAM_DB_PATH: join(databaseDirectory, "audiograms.sqlite"),
    INSTAGRAM_PUBLISHING_DB_PATH: join(databaseDirectory, "approval.sqlite"),
    AUDIOGRAM_LLM_PROVIDER: "openai-api",
    OPENAI_API_KEY: "test-key-not-used-by-injected-provider",
  };
  const metadataRequests = [];
  const transcriptRequests = [];
  const providerConfigs = [];
  let providerRequests = 0;
  const renderedPaths = [];

  return {
    metadataRequests,
    transcriptRequests,
    providerConfigs,
    getProviderRequestCount: () => providerRequests,
    renderedPaths,
    options: {
      url: sourceUrl,
      projectRoot: directory,
      environment,
      dependencies: {
        fetchMetadata: async (url) => {
          metadataRequests.push(url);
          return media;
        },
        fetchTranscript: async (url) => {
          transcriptRequests.push(url);
          if (transcriptError) throw transcriptError;
          return transcript;
        },
        createProvider: (selectionConfig) => {
          providerConfigs.push(selectionConfig);
          const selectionRecipe = buildSelectionRecipe(selectionConfig);
          return {
            generateStructured: async () => {
              providerRequests += 1;
              return {
                parsed: transcriptSelection,
                provenance: {
                  providerId: selectionRecipe.recipe.provider.id,
                  model: selectionRecipe.recipe.provider.model,
                  recipeSha256: selectionRecipe.sha256,
                },
              };
            },
          };
        },
        acquireAssets: async (clipPackage) => [
          { role: "audio", relativePath: `public/generated/${videoId}/audio.wav` },
          { role: "captions", relativePath: `public/generated/${videoId}/captions.json` },
          { role: "thumbnail", relativePath: `public/generated/${videoId}/thumbnail.jpg` },
        ].map((asset) => ({ ...asset, clipPackageId: clipPackage.id })),
        renderTreatment: async ({ clipPackage, treatment }) => {
          const relativePath = `out/treatments/${treatment.id}/${treatment.version}/${videoId}/transcript-llm-v1/clip-${clipPackage.rank}.mp4`;
          const artifactPath = join(directory, relativePath);
          await mkdir(dirname(artifactPath), { recursive: true });
          await writeFile(artifactPath, `fake mp4 ${clipPackage.rank}`);
          renderedPaths.push(relativePath);
          return relativePath;
        },
      },
    },
  };
};

test("defaults direct URL processing to transcript-llm and queues outputs locally", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "single-url-pipeline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const {
    options,
    metadataRequests,
    transcriptRequests,
    providerConfigs,
    getProviderRequestCount,
    renderedPaths,
  } = await createOptions(directory);

  const result = await runSingleUrlPipeline(options);

  assert.deepEqual(metadataRequests, [sourceUrl]);
  assert.deepEqual(transcriptRequests, [sourceUrl]);
  assert.equal(providerConfigs.length, 1);
  assert.equal(providerConfigs[0].selectorId, "transcript-llm");
  assert.equal(getProviderRequestCount(), 1);
  assert.equal(options.environment.AUDIOGRAM_CLIP_SELECTOR, undefined);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.source, { videoId, title: metadata.title, url: sourceUrl });
  assert.deepEqual(result.artifactPaths, renderedPaths);

  const ledger = openAudiogramLedger(options.environment.AUDIOGRAM_DB_PATH);
  try {
    assert.equal(ledger.countVideos(), 1);
    assert.equal(ledger.getVideo(videoId).playlistId, null);
    const job = ledger.getPackageJob(videoId, "transcript-llm-v1");
    assert.equal(job.status, "selection_ready");
    assert.equal(ledger.listClipPackages(job.id).length, 3);
  } finally {
    ledger.close();
  }

  const approvalLedger = createPublishingLedger(
    options.environment.INSTAGRAM_PUBLISHING_DB_PATH,
  );
  try {
    const queued = approvalLedger.getQueue({ state: "queued" });
    assert.equal(queued.length, 3);
    assert.deepEqual(
      queued.map(({ artifactRelativePath }) => artifactRelativePath),
      renderedPaths,
    );
  } finally {
    approvalLedger.close();
  }
  assert.equal((await readFile(join(directory, renderedPaths[0]))).length > 0, true);
});

test("passes safe stage events through the dependency callback", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "single-url-events-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { options } = await createOptions(directory);
  const events = [];
  options.dependencies.onEvent = async (event) => events.push(event);
  await runSingleUrlPipeline(options);
  const orderedStages = ["intake", "metadata", "transcript", "selection", "jev", "assets", "render", "artifact_verification"];
  const firstIndexes = orderedStages.map((stage) => events.findIndex((event) => event.stage === stage));
  assert.ok(firstIndexes.every((index) => index >= 0));
  assert.deepEqual(firstIndexes, [...firstIndexes].sort((a, b) => a - b));
  assert.equal(events.find((event) => event.stage === "jev").status, "skipped");
  assert.equal(events.find((event) => event.stage === "artifact_verification").status, "started");
  assert.equal(events.findLast((event) => event.stage === "artifact_verification").status, "completed");
  assert.equal(JSON.stringify(events).includes("Transcript cue"), false);
});

test("rejects an invalid URL before metadata lookup or ledger creation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "single-url-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { options, metadataRequests } = await createOptions(directory);

  const result = await runSingleUrlPipeline({
    ...options,
    url: "https://example.com/watch?v=dQw4w9WgXcQ",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "INVALID_HOST");
  assert.equal(result.failures[0].stage, "intake");
  assert.equal(result.source, null);
  assert.deepEqual(metadataRequests, []);
});

test("rejects metadata for another video before creating a ledger job", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "single-url-mismatch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { options } = await createOptions(directory, {
    media: { ...metadata, id: "9bZkp7q19f0" },
  });

  const result = await runSingleUrlPipeline(options);

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "VIDEO_ID_MISMATCH");
  assert.equal(result.failures[0].stage, "metadata");
  await assert.rejects(readFile(options.environment.AUDIOGRAM_DB_PATH), {
    code: "ENOENT",
  });
});

test("fails transcript acquisition without falling back to heatmap selection", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "single-url-empty-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { options, metadataRequests, transcriptRequests, providerConfigs } =
    await createOptions(directory, {
      transcriptError: new Error("transcript unavailable"),
    });

  const result = await runSingleUrlPipeline(options);

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "PROCESSING_FAILED");
  assert.equal(result.failures[0].stage, "transcript");
  assert.deepEqual(result.artifactPaths, []);
  assert.deepEqual(metadataRequests, [sourceUrl]);
  assert.deepEqual(transcriptRequests, [sourceUrl]);
  assert.deepEqual(providerConfigs, []);
});

test("reports partial rendering failure with only verified finished clips", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "single-url-partial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { options, renderedPaths } = await createOptions(directory);
  const renderTreatment = options.dependencies.renderTreatment;
  options.dependencies.renderTreatment = async (input) => {
    if (input.clipPackage.rank === 2) throw new Error("render failed");
    return renderTreatment(input);
  };

  const result = await runSingleUrlPipeline(options);

  assert.equal(result.status, "partial");
  assert.equal(result.error.code, "PROCESSING_FAILED");
  assert.equal(result.failures[0].stage, "render");
  assert.deepEqual(result.artifactPaths, renderedPaths);
  assert.equal(result.artifactPaths.length, 2);
});
