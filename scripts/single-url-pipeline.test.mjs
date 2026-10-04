import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { openAudiogramLedger } from "./audiogram-ledger.mjs";
import { createPublishingLedger } from "./publishing-ledger.mjs";
import { runSingleUrlPipeline } from "./single-url-pipeline.mjs";

const videoId = "dQw4w9WgXcQ";
const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`;
const metadata = {
  id: videoId,
  title: "A source video",
  heatmap: [
    { start_time: 0, end_time: 20, value: 1 },
    { start_time: 20, end_time: 40, value: 4 },
    { start_time: 40, end_time: 60, value: 1 },
  ],
};

const createOptions = async (directory, { maxClips = 1, media = metadata } = {}) => {
  const databaseDirectory = join(directory, "state");
  await mkdir(databaseDirectory, { recursive: true });
  const environment = {
    AUDIOGRAM_DB_PATH: join(databaseDirectory, "audiograms.sqlite"),
    INSTAGRAM_PUBLISHING_DB_PATH: join(databaseDirectory, "approval.sqlite"),
    AUDIOGRAM_PACKAGE_VERSION: "url-plugin-v1",
    AUDIOGRAM_MAX_CLIPS: String(maxClips),
  };
  const metadataRequests = [];
  const renderedPaths = [];

  return {
    metadataRequests,
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
        acquireAssets: async (clipPackage) => [
          { role: "audio", relativePath: `public/generated/${videoId}/audio.wav` },
          { role: "captions", relativePath: `public/generated/${videoId}/captions.json` },
          { role: "thumbnail", relativePath: `public/generated/${videoId}/thumbnail.jpg` },
        ].map((asset) => ({ ...asset, clipPackageId: clipPackage.id })),
        renderTreatment: async ({ clipPackage, treatment }) => {
          const relativePath = `out/treatments/${treatment.id}/${treatment.version}/${videoId}/url-plugin-v1/clip-${clipPackage.rank}.mp4`;
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

test("renders one direct URL without playlist OAuth and queues outputs locally", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "single-url-pipeline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { options, metadataRequests, renderedPaths } = await createOptions(directory);

  const result = await runSingleUrlPipeline(options);

  assert.deepEqual(metadataRequests, [sourceUrl]);
  assert.equal(result.status, "complete");
  assert.deepEqual(result.source, { videoId, title: metadata.title, url: sourceUrl });
  assert.deepEqual(result.artifactPaths, renderedPaths);

  const ledger = openAudiogramLedger(options.environment.AUDIOGRAM_DB_PATH);
  try {
    assert.equal(ledger.countVideos(), 1);
    assert.equal(ledger.getVideo(videoId).playlistId, null);
    assert.equal(ledger.getPackageJob(videoId, "url-plugin-v1").status, "selection_ready");
  } finally {
    ledger.close();
  }

  const approvalLedger = createPublishingLedger(
    options.environment.INSTAGRAM_PUBLISHING_DB_PATH,
  );
  try {
    const queued = approvalLedger.getQueue({ state: "queued" });
    assert.equal(queued.length, 1);
    assert.equal(queued[0].artifactRelativePath, renderedPaths[0]);
  } finally {
    approvalLedger.close();
  }
  assert.equal((await readFile(join(directory, renderedPaths[0]))).length > 0, true);
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
  await assert.rejects(readFile(options.environment.AUDIOGRAM_DB_PATH), {
    code: "ENOENT",
  });
});

test("reports no clips without claiming artifact paths", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "single-url-empty-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { options } = await createOptions(directory, {
    media: { ...metadata, heatmap: [] },
  });

  const result = await runSingleUrlPipeline(options);

  assert.equal(result.status, "no_clips");
  assert.equal(result.error.code, "NO_CLIPS");
  assert.deepEqual(result.artifactPaths, []);
});

test("reports partial rendering failure with only verified finished clips", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "single-url-partial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { options, renderedPaths } = await createOptions(directory, {
    maxClips: 2,
    media: {
      ...metadata,
      heatmap: [
        { start_time: 0, end_time: 20, value: 1 },
        { start_time: 20, end_time: 40, value: 4 },
        { start_time: 40, end_time: 60, value: 1 },
        { start_time: 60, end_time: 80, value: 5 },
        { start_time: 80, end_time: 100, value: 1 },
      ],
    },
  });
  const renderTreatment = options.dependencies.renderTreatment;
  options.dependencies.renderTreatment = async (input) => {
    if (input.clipPackage.rank === 2) throw new Error("render failed");
    return renderTreatment(input);
  };

  const result = await runSingleUrlPipeline(options);

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "PROCESSING_FAILED");
  assert.deepEqual(result.artifactPaths, renderedPaths);
  assert.equal(result.artifactPaths.length, 1);
});
