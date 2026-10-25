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
import { validateCliResult } from "../plugins/audiogram-helper/result-validation.mjs";
import { SafeDiagnosticError } from "./error-diagnostics.mjs";

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
      contextSummary:
        "Provides setup for a new listener to understand the idea.",
      insightSummary:
        "States the substantive insight grounded in transcript cues.",
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

const createOptions = async (
  directory,
  {
    media = metadata,
    transcriptError,
    selection = transcriptSelection,
    selections,
  } = {},
) => {
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
  const selectionRequests = [];
  const renderedPaths = [];

  return {
    metadataRequests,
    transcriptRequests,
    providerConfigs,
    getProviderRequestCount: () => providerRequests,
    selectionRequests,
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
            generateStructured: async (request) => {
              providerRequests += 1;
              selectionRequests.push(request);
              const parsed = selections
                ? selections[
                    Math.min(providerRequests - 1, selections.length - 1)
                  ]
                : selection;
              if (parsed instanceof Error) throw parsed;
              return {
                parsed,
                provenance: {
                  providerId: selectionRecipe.recipe.provider.id,
                  model: selectionRecipe.recipe.provider.model,
                  recipeSha256: selectionRecipe.sha256,
                },
              };
            },
          };
        },
        acquireAssets: async (clipPackage) =>
          [
            {
              role: "audio",
              relativePath: `public/generated/${videoId}/audio.wav`,
            },
            {
              role: "captions",
              relativePath: `public/generated/${videoId}/captions.json`,
            },
            {
              role: "thumbnail",
              relativePath: `public/generated/${videoId}/thumbnail.jpg`,
            },
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
  assert.deepEqual(result.source, {
    videoId,
    title: metadata.title,
    url: sourceUrl,
  });
  assert.deepEqual([...result.artifactPaths].sort(), [...renderedPaths].sort());

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
  assert.equal(
    (await readFile(join(directory, renderedPaths[0]))).length > 0,
    true,
  );
});

test("passes safe stage events through the dependency callback", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "single-url-events-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { options } = await createOptions(directory);
  const events = [];
  options.dependencies.onEvent = async (event) => events.push(event);
  await runSingleUrlPipeline(options);
  const orderedStages = [
    "intake",
    "metadata",
    "transcript",
    "selection",
    "jev",
    "assets",
    "render",
    "artifact_verification",
  ];
  const firstIndexes = orderedStages.map((stage) =>
    events.findIndex((event) => event.stage === stage),
  );
  assert.ok(firstIndexes.every((index) => index >= 0));
  assert.deepEqual(
    firstIndexes,
    [...firstIndexes].sort((a, b) => a - b),
  );
  assert.equal(events.find((event) => event.stage === "jev").status, "skipped");
  assert.equal(
    events.find((event) => event.stage === "artifact_verification").status,
    "started",
  );
  assert.equal(
    events.findLast((event) => event.stage === "artifact_verification").status,
    "completed",
  );
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

test("reports post-metadata configuration errors as setup failures", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "single-url-setup-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { options } = await createOptions(directory);
  options.dependencies.resolveSelectionConfig = () => {
    throw new Error("private configuration detail");
  };

  const result = await runSingleUrlPipeline(options);
  const safeResult = await validateCliResult(result, directory);

  assert.equal(result.failures[0].stage, "setup");
  assert.equal(result.failures[0].code, "PIPELINE_SETUP_FAILED");
  assert.equal(
    result.failures[0].message,
    "Audiogram processing could not be configured.",
  );
  assert.deepEqual(safeResult.failures, result.failures);
});

for (const invalidCue of [true, false]) {
  test(`reports ${invalidCue ? "SELECTION_INVALID_CUE" : "SELECTION_FAILED"} through the CLI result boundary`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "selection-error-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const selection = structuredClone(transcriptSelection);
    selection.clips[0].insightCueId = invalidCue ? "c002361" : "c000002";
    const { options, renderedPaths, getProviderRequestCount } =
      await createOptions(directory, { selection });
    const events = [];
    options.dependencies.onEvent = (event) => events.push(event);

    const result = await runSingleUrlPipeline(options);
    const safeResult = await validateCliResult(result, directory);
    const code = invalidCue ? "SELECTION_INVALID_CUE" : "SELECTION_FAILED";
    const message = invalidCue
      ? "Clip selection referenced a cue that is not in the transcript."
      : "Clip selection failed.";
    assert.equal(result.status, "failed");
    assert.deepEqual(result.failures, [{ stage: "selection", code, message }]);
    assert.deepEqual(safeResult.failures, result.failures);
    assert.equal(safeResult.error, message);
    assert.deepEqual(safeResult.artifacts, []);
    assert.deepEqual(renderedPaths, []);
    assert.equal(getProviderRequestCount(), 2);
    assert.equal(
      events.some((event) => event.stage === "jev"),
      false,
    );
    assert.equal(JSON.stringify(result).includes("c002361"), false);
  });
}

for (const invalidCue of [true, false]) {
  test(`recovers once from invalid ${invalidCue ? "cue membership" : "evidence order"} before rendering`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "selection-recovery-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const invalid = structuredClone(transcriptSelection);
    invalid.clips[0].insightCueId = invalidCue ? "c002361" : "c000002";
    const {
      options,
      getProviderRequestCount,
      renderedPaths,
      selectionRequests,
    } = await createOptions(directory, {
      selections: [invalid, transcriptSelection],
    });
    const events = [];
    options.dependencies.onEvent = (event) => events.push(event);
    const result = await runSingleUrlPipeline(options);
    assert.equal(result.status, "complete");
    assert.equal(getProviderRequestCount(), 2);
    assert.equal(renderedPaths.length, 3);
    assert.equal(
      events.filter(
        (event) => event.stage === "selection" && event.status === "retrying",
      ).length,
      1,
    );
    const initial = JSON.parse(selectionRequests[0].input);
    const corrected = JSON.parse(selectionRequests[1].input);
    assert.deepEqual(corrected.cues, initial.cues);
    assert.equal(
      corrected.validationFeedback.code,
      invalidCue ? "SELECTION_INVALID_CUE" : "SELECTION_INVALID_OUTPUT",
    );
    assert.equal(selectionRequests[1].input.includes("c002361"), false);
    assert.equal(JSON.stringify(events).includes("c002361"), false);
  });
}

for (const code of [
  "selection_output_invalid",
  "provider_response_invalid",
  "provider_request_failed",
]) {
  test(`selection recovery is bounded and distinguishes ${code}`, async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "selection-provider-recovery-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const error = new SafeDiagnosticError({ providerId: "openai-api", code });
    for (const recover of [true, false]) {
      const runDirectory = join(directory, String(recover));
      const { options, getProviderRequestCount, renderedPaths } =
        await createOptions(runDirectory, {
          selections: [error, recover ? transcriptSelection : error],
        });
      const result = await runSingleUrlPipeline(options);
      const allowed = code === "selection_output_invalid";
      assert.equal(getProviderRequestCount(), allowed ? 2 : 1);
      assert.equal(result.status, allowed && recover ? "complete" : "failed");
      assert.equal(renderedPaths.length, allowed && recover ? 3 : 0);
    }
  });
}

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

test("retries failed transcript work when the caller marks a job as a retry", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "single-url-retry-transcript-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { options } = await createOptions(directory);
  let failTranscript = true;
  options.dependencies.fetchTranscript = async () => {
    if (failTranscript) throw new Error("temporary transcript failure");
    return transcript;
  };

  const first = await runSingleUrlPipeline(options);
  failTranscript = false;
  const retried = await runSingleUrlPipeline({
    ...options,
    dependencies: { ...options.dependencies, retryFailedPipeline: true },
  });

  assert.equal(first.status, "failed");
  assert.equal(retried.status, "complete");
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
  assert.deepEqual([...result.artifactPaths].sort(), [...renderedPaths].sort());
  assert.equal(result.artifactPaths.length, 2);
});

test("reports artifact verification failure when rendering records no verified files", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "single-url-unverified-artifact-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { options } = await createOptions(directory);
  options.dependencies.renderTreatment = async ({ clipPackage, treatment }) =>
    `out/treatments/${treatment.id}/${treatment.version}/${videoId}/transcript-llm-v1/clip-${clipPackage.rank}.mp4`;

  const result = await runSingleUrlPipeline(options);

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "NO_VERIFIED_ARTIFACTS");
  assert.deepEqual(result.failures, [
    {
      stage: "artifact_verification",
      code: "NO_VERIFIED_ARTIFACTS",
      message: "Processing did not produce a verified MP4 artifact.",
    },
  ]);
});

test("invalid template fails before metadata or database work", async () => {
  let calls = 0;
  const result = await runSingleUrlPipeline({
    url: sourceUrl,
    templateSelection: { templateId: "missing" },
    dependencies: {
      fetchMetadata: async () => {
        calls++;
        return metadata;
      },
      openLedger: () => {
        calls++;
        throw Error("must not open");
      },
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.error.code, "INVALID_TEMPLATE_SELECTION");
});
test("unrelated failed treatment does not fail a completed selected result", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "single-selected-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { options } = await createOptions(directory);
  assert.equal((await runSingleUrlPipeline(options)).status, "complete");
  const { openAudiogramLedger } = await import("./audiogram-ledger.mjs");
  const ledger = openAudiogramLedger(options.environment.AUDIOGRAM_DB_PATH);
  const job = ledger.getPackageJob(videoId, "transcript-llm-v1");
  for (const pkg of ledger.listClipPackages(job.id)) {
    const run = ledger.ensureTreatmentRun({
      packageId: pkg.id,
      treatmentId: "other",
      treatmentVersion: "1",
    });
    ledger.markTreatmentRunFailed(run.id, "Other style failed");
  }
  ledger.close();
  assert.equal((await runSingleUrlPipeline(options)).status, "complete");
});

test("returns only the requested treatment artifacts when another treatment exists", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "selected-results-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { options } = await createOptions(directory);
  const first = await runSingleUrlPipeline(options);
  assert.equal(first.status, "complete");
  const { createTreatmentRegistry, audiogramBasicTreatment } =
    await import("./treatment-registry.mjs");
  options.dependencies.registry = createTreatmentRegistry([
    audiogramBasicTreatment,
    { ...audiogramBasicTreatment, id: "test-only" },
  ]);
  options.dependencies.resolveTemplateSelectionConfig = () => ({
    selection: {
      templateId: "test-only",
      templateVersion: "1",
      variationId: "default",
    },
    treatment: { id: "test-only", version: "1" },
    compositionId: "AudiogramBasic",
    renderKey: "test-only@1",
  });
  const second = await runSingleUrlPipeline(options);
  assert.equal(second.status, "complete");
  assert.equal(second.artifactPaths.length, 3);
  assert.ok(
    second.artifactPaths.every((p) =>
      p.startsWith("out/treatments/test-only/1/"),
    ),
  );
  assert.ok(
    second.artifactPaths.every((p) => !first.artifactPaths.includes(p)),
  );
  await rm(join(directory, second.artifactPaths[0]));
  const missing = await runSingleUrlPipeline(options);
  assert.ok(!missing.artifactPaths.includes(second.artifactPaths[0]));
  assert.equal(missing.status, "partial");
  assert.equal(missing.artifactPaths.length, 2);
});

test("explicit retry recovers only the failed render and preserves completed clips", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "single-retry-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { options } = await createOptions(directory);
  const render = options.dependencies.renderTreatment;
  const attempts = [];
  let shouldFail = true;
  options.dependencies.renderTreatment = async (input) => {
    attempts.push(input.clipPackage.rank);
    if (input.clipPackage.rank === 2 && shouldFail)
      throw Error("synthetic render failure");
    return render(input);
  };
  assert.equal((await runSingleUrlPipeline(options)).status, "partial");
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.equal((await runSingleUrlPipeline(options)).status, "partial");
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.equal(
    (await runSingleUrlPipeline({ ...options, retryFailedRenders: true }))
      .status,
    "partial",
  );
  assert.deepEqual(attempts, [1, 2, 3, 2]);
  shouldFail = false;
  const result = await runSingleUrlPipeline({
    ...options,
    retryFailedRenders: true,
  });
  assert.equal(result.status, "complete");
  assert.equal(result.artifactPaths.length, 3);
  assert.deepEqual(attempts, [1, 2, 3, 2, 2]);
  assert.equal(
    (await runSingleUrlPipeline({ ...options, retryFailedRenders: true }))
      .status,
    "complete",
  );
  assert.deepEqual(attempts, [1, 2, 3, 2, 2]);
  const ledger = openAudiogramLedger(options.environment.AUDIOGRAM_DB_PATH);
  try {
    const job = ledger.getPackageJob(videoId, "transcript-llm-v1");
    const pkg = ledger.listClipPackages(job.id).find((p) => p.rank === 2);
    const run = ledger.listTreatmentRuns(pkg.id)[0];
    const retries = ledger.listTreatmentRunRetries(run.id);
    assert.equal(retries.length, 2);
    assert.ok(
      retries.every((r) => r.previous_error === "synthetic render failure"),
    );
    assert.equal(run.status, "rendered");
  } finally {
    ledger.close();
  }
});
