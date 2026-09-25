import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import * as audiogramLedger from "./audiogram-ledger.mjs";
import { canonicalJson, sha256Canonical } from "./canonical-json.mjs";
import {
  buildSelectionRecipe,
  HEATMAP_SCHEMA_SHA256,
} from "./clip-selection-contract.mjs";
import { computeTranscriptIdentity } from "./youtube-transcript-core.mjs";

const { openAudiogramLedger } = audiogramLedger;
const timestamp = "2026-09-18T12:00:00.000Z";
const defaultHeatmapRecipe = buildSelectionRecipe({
  selectorId: "youtube-heatmap",
  maxClips: 1,
  minimumSeparationMs: 20_000,
});
const widerHeatmapRecipe = buildSelectionRecipe({
  selectorId: "youtube-heatmap",
  maxClips: 2,
  minimumSeparationMs: 5_000,
});
const transcriptRecipe = buildSelectionRecipe({
  selectorId: "transcript-llm",
  providerId: "openai-api",
  desiredClipCount: 3,
});
const legacyUnknownRecipe = {
  recipeVersion: 1,
  selector: { id: "youtube-heatmap-legacy", version: "0" },
  provider: null,
  prompt: null,
  outputSchema: { version: 1, sha256: HEATMAP_SCHEMA_SHA256 },
  parameters: { maxClips: "unknown", minimumSeparationMs: "unknown" },
};
const recipeEnvelope = (recipe) => ({
  recipe,
  json: canonicalJson(recipe),
  sha256: sha256Canonical(recipe),
});
const heatmap = [{ startTime: 10, endTime: 30, value: 0.9 }];
const heatmapPackages = [
  { rank: 1, startSeconds: 10, endSeconds: 30, score: 0.9 },
];
const transcript = {
  source: "youtube_creator",
  language: "en",
  cues: [
    { id: "c000001", startMs: 0, endMs: 10_000, text: "Context one" },
    { id: "c000002", startMs: 10_000, endMs: 20_000, text: "Insight one" },
    { id: "c000003", startMs: 20_000, endMs: 31_000, text: "Payoff one" },
  ],
};
Object.assign(transcript, computeTranscriptIdentity(transcript));
const transcriptResult = {
  clips: [
    {
      rank: 1,
      title: "A complete useful idea",
      ideaKey: "useful-idea",
      startCueId: "c000001",
      contextCueId: "c000001",
      insightCueId: "c000002",
      payoffCueId: "c000003",
      endCueId: "c000003",
      contextSummary: "Enough setup for the useful central claim",
      insightSummary: "The central claim contains a useful insight",
      payoffSummary: "The consequence completes the useful thought",
      score: 0.9,
      editorialChecks: {
        selfContained: true,
        hasSetupBeforeClaim: true,
        completeThought: true,
        substantiveInsight: true,
        containsSponsorOrCta: false,
      },
    },
  ],
};

const createCurrentGenericSchema = (
  database,
  { includeOptionalAssetColumns = true, includeTreatmentLastError = true } = {},
) => {
  const optionalAssetColumns = includeOptionalAssetColumns
    ? "provenance TEXT, metadata_json TEXT,"
    : "";
  const treatmentLastErrorColumn = includeTreatmentLastError
    ? "last_error TEXT,"
    : "";

  database.exec(`
    CREATE TABLE videos (
      video_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_url TEXT NOT NULL,
      playlist_id TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE package_jobs (
      id INTEGER PRIMARY KEY,
      video_id TEXT NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
      package_version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'discovered'
        CHECK (status IN ('discovered', 'heatmap_ready', 'no_heatmap', 'failed')),
      heatmap_json TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (video_id, package_version)
    ) STRICT;

    CREATE TABLE clip_packages (
      id INTEGER PRIMARY KEY,
      package_job_id INTEGER NOT NULL REFERENCES package_jobs(id) ON DELETE CASCADE,
      rank INTEGER NOT NULL CHECK (rank >= 1),
      start_seconds REAL NOT NULL CHECK (start_seconds >= 0),
      end_seconds REAL NOT NULL CHECK (end_seconds > start_seconds),
      score REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'selected'
        CHECK (status IN ('selected', 'ready', 'failed')),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (package_job_id, rank)
    ) STRICT;

    CREATE TABLE clip_assets (
      id INTEGER PRIMARY KEY,
      clip_package_id INTEGER NOT NULL REFERENCES clip_packages(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      ${optionalAssetColumns}
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (clip_package_id, role)
    ) STRICT;

    CREATE TABLE treatment_runs (
      id INTEGER PRIMARY KEY,
      clip_package_id INTEGER NOT NULL REFERENCES clip_packages(id) ON DELETE CASCADE,
      treatment_id TEXT NOT NULL,
      treatment_version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'rendered', 'failed')),
      artifact_relative_path TEXT,
      ${treatmentLastErrorColumn}
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (clip_package_id, treatment_id, treatment_version)
    ) STRICT;

    CREATE INDEX package_jobs_status_idx ON package_jobs(status);
    CREATE INDEX clip_packages_status_idx ON clip_packages(status);
    CREATE INDEX treatment_runs_status_idx ON treatment_runs(status);
  `);
};

const insertRepresentativeGenericData = (
  database,
  { includeOptionalAssetColumns = true } = {},
) => {
  database.exec(`
    INSERT INTO videos VALUES (
      'video-1', 'Generic video', 'https://youtu.be/video-1', 'playlist-1',
      '2026-09-18T12:00:00.000Z', '2026-09-18T12:00:00.000Z'
    );
    INSERT INTO package_jobs VALUES (
      1, 'video-1', 'v1', 'heatmap_ready',
      '[{"startTime":10,"endTime":30,"value":0.9}]', NULL,
      '2026-09-18T12:00:00.000Z', '2026-09-18T12:00:00.000Z'
    );
    INSERT INTO clip_packages VALUES (
      1, 1, 1, 10.0, 30.0, 0.9, 'ready', NULL,
      '2026-09-18T12:00:00.000Z', '2026-09-18T12:00:00.000Z'
    );
    INSERT INTO clip_assets (
      id, clip_package_id, role, relative_path,
      ${includeOptionalAssetColumns ? "provenance, metadata_json," : ""}
      created_at, updated_at
    ) VALUES (
      1, 1, 'audio', 'public/generated/video-1/v1/clip-1/audio.wav',
      ${includeOptionalAssetColumns ? "'yt-dlp', '{\"codec\":\"wav\"}'," : ""}
      '2026-09-18T12:00:00.000Z', '2026-09-18T12:00:00.000Z'
    );
    INSERT INTO treatment_runs VALUES (
      1, 1, 'audiogram-basic', '1', 'rendered',
      'out/treatments/audiogram-basic/1/video-1/clip-1.mp4', NULL,
      '2026-09-18T12:00:00.000Z', '2026-09-18T12:00:00.000Z'
    );
  `);
};

const readSchemaSql = (database) =>
  database
    .prepare(
      `SELECT type, name, sql FROM sqlite_schema
       WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
       ORDER BY type, name`,
    )
    .all();

const readSchemaVersion = (database) =>
  database.prepare("PRAGMA user_version").get().user_version;

test("legacy schema version migration preserves processing records", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ledger.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE videos (
      video_id TEXT PRIMARY KEY, title TEXT NOT NULL, source_url TEXT NOT NULL,
      playlist_id TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE processing_jobs (
      id INTEGER PRIMARY KEY, video_id TEXT NOT NULL,
      treatment_version TEXT NOT NULL, status TEXT NOT NULL,
      heatmap_json TEXT, last_error TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, UNIQUE (video_id, treatment_version)
    ) STRICT;
    CREATE TABLE clips (
      id INTEGER PRIMARY KEY, processing_job_id INTEGER NOT NULL,
      rank INTEGER NOT NULL, start_seconds REAL NOT NULL,
      end_seconds REAL NOT NULL, score REAL NOT NULL, status TEXT NOT NULL,
      artifact_relative_path TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, UNIQUE (processing_job_id, rank)
    ) STRICT;
    INSERT INTO videos VALUES (
      'video-1', 'Legacy video', 'https://youtu.be/video-1', 'playlist-1',
      '2026-09-16T12:00:00.000Z', '2026-09-16T12:00:00.000Z'
    );
    INSERT INTO processing_jobs VALUES (
      1, 'video-1', 'v1', 'rendered', '[]', NULL,
      '2026-09-16T12:00:00.000Z', '2026-09-16T12:00:00.000Z'
    );
    INSERT INTO clips VALUES (
      1, 1, 1, 10.0, 30.0, 0.9, 'rendered',
      'out/legacy-video.mp4', '2026-09-16T12:00:00.000Z',
      '2026-09-16T12:00:00.000Z'
    );
  `);
  legacy.close();

  let ledger = openAudiogramLedger(path, {
    selectionRecipe: defaultHeatmapRecipe,
    packageVersion: "v1",
  });
  t.after(() => ledger?.close());

  const job = ledger.getPackageJob("video-1", "v1");
  assert.equal(job.status, "selection_ready");
  const [clipPackage] = ledger.listClipPackages(job.id);
  assert.equal(clipPackage.status, "ready");
  assert.deepEqual(ledger.listTreatmentRuns(clipPackage.id), [
    {
      id: 1,
      clipPackageId: clipPackage.id,
      treatmentId: "audiogram-basic",
      treatmentVersion: "1",
      status: "rendered",
      artifactRelativePath: "out/legacy-video.mp4",
      lastError: null,
      createdAt: "2026-09-16T12:00:00.000Z",
      updatedAt: "2026-09-16T12:00:00.000Z",
    },
  ]);
  assert.equal(ledger.countVideos(), 1);
  assert.equal(ledger.countPackageJobs(), 1);
  assert.equal(ledger.getSchemaVersion(), 2);
  assert.deepEqual(ledger.getSelectionRun(job.id).result, {
    schemaVersion: 1,
    heatmap: [],
    clips: heatmapPackages,
  });

  ledger.close();
  ledger = null;
  const migrated = new DatabaseSync(path);
  assert.equal(readSchemaVersion(migrated), 2);
  migrated.close();
});

test("fresh database schema version 2 creates provenance tables and JSON constraints", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ledger.sqlite");

  const ledger = openAudiogramLedger(path);
  assert.equal(audiogramLedger.AUDIOGRAM_SCHEMA_VERSION, 2);
  assert.equal(ledger.getSchemaVersion(), 2);
  ledger.close();

  const database = new DatabaseSync(path);
  assert.deepEqual(
    database
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all()
      .map(({ name }) => name),
    [
      "analyses",
      "analysis_answers",
      "clip_assets",
      "clip_packages",
      "package_jobs",
      "selection_runs",
      "transcripts",
      "treatment_runs",
      "videos",
    ],
  );
  assert.equal(readSchemaVersion(database), 2);
  database.exec(`
    INSERT INTO videos VALUES (
      'video-1', 'title', 'https://youtu.be/video-1', NULL,
      '${timestamp}', '${timestamp}'
    );
  `);
  assert.throws(
    () =>
      database
        .prepare(
          `
          INSERT INTO package_jobs (
            video_id, package_version, status, selection_recipe_json,
            selection_recipe_sha256, created_at, updated_at
          ) VALUES ('video-1', 'bad', 'discovered', 'not-json', 'bad', ?, ?)
        `,
        )
        .run(timestamp, timestamp),
    /constraint|json/i,
  );
  database
    .prepare(
      `
      INSERT INTO package_jobs (
        video_id, package_version, status, selection_recipe_json,
        selection_recipe_sha256, created_at, updated_at
      ) VALUES ('video-1', 'v1', 'discovered', ?, ?, ?, ?)
    `,
    )
    .run(
      defaultHeatmapRecipe.json,
      defaultHeatmapRecipe.sha256,
      timestamp,
      timestamp,
    );
  assert.throws(
    () =>
      database
        .prepare(
          `
          INSERT INTO transcripts (
            video_id, source, language, content_sha256, cues_json, cue_count,
            canonical_utf8_bytes, created_at, updated_at
          ) VALUES ('video-1', 'youtube_creator', 'en', 'hash', 'bad', 1, 1, ?, ?)
        `,
        )
        .run(timestamp, timestamp),
    /constraint|json/i,
  );
  assert.throws(
    () =>
      database
        .prepare(
          `
          INSERT INTO selection_runs (
            package_job_id, selector_id, selector_version,
            output_schema_version, output_schema_sha256, result_json,
            created_at, updated_at
          ) VALUES (1, 'youtube-heatmap', '1', 1, 'hash', 'bad', ?, ?)
        `,
        )
        .run(timestamp, timestamp),
    /constraint|json/i,
  );
  assert.throws(
    () =>
      database
        .prepare(
          `
          INSERT INTO package_jobs (
            video_id, package_version, status, selection_recipe_json,
            selection_recipe_sha256, created_at, updated_at
          ) VALUES ('missing-video', 'v2', 'discovered', ?, ?, ?, ?)
        `,
        )
        .run(
          defaultHeatmapRecipe.json,
          defaultHeatmapRecipe.sha256,
          timestamp,
          timestamp,
        ),
    /constraint|foreign key/i,
  );
  database.close();
});

test("exact unversioned generic schema is adopted without losing data", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ledger.sqlite");
  const unversioned = new DatabaseSync(path);
  createCurrentGenericSchema(unversioned);
  insertRepresentativeGenericData(unversioned);
  const schemaBefore = readSchemaSql(unversioned);
  unversioned.close();

  const ledger = openAudiogramLedger(path);
  assert.equal(ledger.getSchemaVersion(), 2);
  assert.equal(ledger.getPackageJob("video-1", "v1").status, "selection_ready");
  assert.deepEqual(ledger.getClipPackage(1).assets, [
    {
      id: 1,
      clipPackageId: 1,
      role: "audio",
      relativePath: "public/generated/video-1/v1/clip-1/audio.wav",
      provenance: "yt-dlp",
      metadataJson: '{"codec":"wav"}',
      createdAt: "2026-09-18T12:00:00.000Z",
      updatedAt: "2026-09-18T12:00:00.000Z",
    },
  ]);
  assert.equal(ledger.listTreatmentRuns(1)[0].status, "rendered");
  ledger.close();

  const adopted = new DatabaseSync(path);
  assert.notDeepEqual(readSchemaSql(adopted), schemaBefore);
  assert.equal(readSchemaVersion(adopted), 2);
  adopted.close();
});

test("unversioned generic schema adds only historical optional asset columns", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ledger.sqlite");
  const unversioned = new DatabaseSync(path);
  createCurrentGenericSchema(unversioned, {
    includeOptionalAssetColumns: false,
  });
  insertRepresentativeGenericData(unversioned, {
    includeOptionalAssetColumns: false,
  });
  const otherSchemaBefore = readSchemaSql(unversioned).filter(
    ({ name }) => name !== "clip_assets",
  );
  unversioned.close();

  const ledger = openAudiogramLedger(path);
  assert.equal(ledger.getSchemaVersion(), 2);
  assert.deepEqual(ledger.getClipPackage(1).assets, [
    {
      id: 1,
      clipPackageId: 1,
      role: "audio",
      relativePath: "public/generated/video-1/v1/clip-1/audio.wav",
      provenance: null,
      metadataJson: null,
      createdAt: "2026-09-18T12:00:00.000Z",
      updatedAt: "2026-09-18T12:00:00.000Z",
    },
  ]);
  ledger.close();

  const adopted = new DatabaseSync(path);
  assert.deepEqual(
    adopted
      .prepare("PRAGMA table_info(clip_assets)")
      .all()
      .map(({ name }) => name),
    [
      "id",
      "clip_package_id",
      "role",
      "relative_path",
      "created_at",
      "updated_at",
      "provenance",
      "metadata_json",
    ],
  );
  assert.notDeepEqual(
    readSchemaSql(adopted).filter(({ name }) => name !== "clip_assets"),
    otherSchemaBefore,
  );
  assert.equal(readSchemaVersion(adopted), 2);
  adopted.close();
});

test("too-new schema version is rejected without changing schema SQL", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ledger.sqlite");
  const tooNew = new DatabaseSync(path);
  createCurrentGenericSchema(tooNew);
  tooNew.exec("PRAGMA user_version = 3");
  const schemaBefore = readSchemaSql(tooNew);
  tooNew.close();

  assert.throws(
    () => openAudiogramLedger(path),
    /schema version 3|unsupported|newer/i,
  );

  const unchanged = new DatabaseSync(path);
  assert.deepEqual(readSchemaSql(unchanged), schemaBefore);
  assert.equal(readSchemaVersion(unchanged), 3);
  unchanged.close();
});

test("ambiguous mixed legacy and generic schema is rejected at version 0", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ledger.sqlite");
  const mixed = new DatabaseSync(path);
  createCurrentGenericSchema(mixed);
  mixed.exec(`
    CREATE TABLE processing_jobs (
      id INTEGER PRIMARY KEY, video_id TEXT NOT NULL,
      treatment_version TEXT NOT NULL, status TEXT NOT NULL,
      heatmap_json TEXT, last_error TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, UNIQUE (video_id, treatment_version)
    ) STRICT;
    CREATE TABLE clips (
      id INTEGER PRIMARY KEY, processing_job_id INTEGER NOT NULL,
      rank INTEGER NOT NULL, start_seconds REAL NOT NULL,
      end_seconds REAL NOT NULL, score REAL NOT NULL, status TEXT NOT NULL,
      artifact_relative_path TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, UNIQUE (processing_job_id, rank)
    ) STRICT;
  `);
  const schemaBefore = readSchemaSql(mixed);
  mixed.close();

  assert.throws(() => openAudiogramLedger(path), /ambiguous|mixed/i);

  const unchanged = new DatabaseSync(path);
  assert.deepEqual(readSchemaSql(unchanged), schemaBefore);
  assert.equal(readSchemaVersion(unchanged), 0);
  unchanged.close();
});

test("malformed unversioned generic schema rolls back migration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ledger.sqlite");
  const malformed = new DatabaseSync(path);
  createCurrentGenericSchema(malformed, {
    includeOptionalAssetColumns: false,
    includeTreatmentLastError: false,
  });
  const schemaBefore = readSchemaSql(malformed);
  malformed.close();

  assert.throws(
    () => openAudiogramLedger(path),
    /invalid|malformed|missing.*last_error/i,
  );

  const unchanged = new DatabaseSync(path);
  assert.deepEqual(readSchemaSql(unchanged), schemaBefore);
  assert.equal(readSchemaVersion(unchanged), 0);
  unchanged.close();
});

test("playlist sync is idempotent and preserves completed packaging", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"), {
    now: () => "2026-09-16T12:00:00.000Z",
  });
  t.after(() => ledger.close());

  const firstSync = ledger.syncPlaylistVideos({
    playlistId: "playlist-1",
    packageVersion: "v1",
    videos: [
      {
        videoId: "video-1",
        title: "Original title",
        url: "https://www.youtube.com/watch?v=video-1",
      },
    ],
  });

  assert.deepEqual(firstSync, { discovered: 1, existing: 0 });
  const job = ledger.getPackageJob("video-1", "v1");
  assert.equal(job.status, "discovered");

  ledger.recordHeatmapSelection({
    jobId: job.id,
    heatmap: [{ startTime: 10, endTime: 30, value: 0.9 }],
    packages: [{ rank: 1, startSeconds: 10, endSeconds: 30, score: 0.9 }],
  });

  const secondSync = ledger.syncPlaylistVideos({
    playlistId: "playlist-1",
    packageVersion: "v1",
    videos: [
      {
        videoId: "video-1",
        title: "Updated title",
        url: "https://www.youtube.com/watch?v=video-1",
      },
    ],
  });

  assert.deepEqual(secondSync, { discovered: 0, existing: 1 });
  assert.equal(ledger.getVideo("video-1").title, "Updated title");
  assert.equal(ledger.getPackageJob("video-1", "v1").status, "selection_ready");
  assert.deepEqual(ledger.listClipPackages(job.id), [
    {
      id: 1,
      packageJobId: job.id,
      rank: 1,
      startSeconds: 10,
      endSeconds: 30,
      score: 0.9,
      status: "selected",
      lastError: null,
      createdAt: "2026-09-16T12:00:00.000Z",
      updatedAt: "2026-09-16T12:00:00.000Z",
    },
  ]);
  assert.deepEqual(ledger.listPendingPackageJobs(), []);
});

test("a new package version creates a new job without duplicating the video", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"));
  t.after(() => ledger.close());

  const input = {
    playlistId: "playlist-1",
    videos: [
      {
        videoId: "video-1",
        title: "A video",
        url: "https://www.youtube.com/watch?v=video-1",
      },
    ],
  };

  ledger.syncPlaylistVideos({ ...input, packageVersion: "v1" });
  ledger.syncPlaylistVideos({ ...input, packageVersion: "v2" });

  assert.equal(ledger.countVideos(), 1);
  assert.equal(ledger.countPackageJobs(), 2);
});

test("a job can retain multiple ranked clips", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"));
  t.after(() => ledger.close());

  ledger.syncPlaylistVideos({
    playlistId: "playlist-1",
    packageVersion: "v1",
    videos: [
      {
        videoId: "video-1",
        title: "A video",
        url: "https://www.youtube.com/watch?v=video-1",
      },
    ],
  });
  const job = ledger.getPackageJob("video-1", "v1");

  ledger.recordHeatmapSelection({
    jobId: job.id,
    heatmap: [],
    packages: [
      { rank: 1, startSeconds: 10, endSeconds: 30, score: 0.9 },
      { rank: 2, startSeconds: 90, endSeconds: 110, score: 0.7 },
    ],
  });

  assert.deepEqual(
    ledger
      .listClipPackages(job.id)
      .map(({ rank, startSeconds, endSeconds }) => ({
        rank,
        startSeconds,
        endSeconds,
      })),
    [
      { rank: 1, startSeconds: 10, endSeconds: 30 },
      { rank: 2, startSeconds: 90, endSeconds: 110 },
    ],
  );
});

test("ready packages retain typed assets and one idempotent treatment run", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"), {
    now: () => "2026-09-18T12:00:00.000Z",
  });
  t.after(() => ledger.close());

  ledger.syncPlaylistVideos({
    playlistId: "playlist-1",
    packageVersion: "v1",
    videos: [
      { videoId: "video-1", title: "A video", url: "https://youtu.be/video-1" },
    ],
  });
  const job = ledger.getPackageJob("video-1", "v1");
  ledger.recordHeatmapSelection({
    jobId: job.id,
    heatmap: [],
    packages: [{ rank: 1, startSeconds: 10, endSeconds: 30, score: 0.9 }],
  });
  const [clipPackage] = ledger.listClipPackages(job.id);
  const assets = [
    {
      role: "audio",
      relativePath: "public/generated/video-1/v1/clip-1/audio.wav",
    },
    {
      role: "captions",
      relativePath: "public/generated/video-1/v1/clip-1/captions.json",
    },
  ];

  ledger.markPackageReady({ packageId: clipPackage.id, assets });
  ledger.markPackageReady({ packageId: clipPackage.id, assets });
  const firstRun = ledger.ensureTreatmentRun({
    packageId: clipPackage.id,
    treatmentId: "audiogram-basic",
    treatmentVersion: "1",
  });
  const secondRun = ledger.ensureTreatmentRun({
    packageId: clipPackage.id,
    treatmentId: "audiogram-basic",
    treatmentVersion: "1",
  });

  assert.equal(firstRun.id, secondRun.id);
  assert.equal(ledger.listTreatmentRuns(clipPackage.id).length, 1);
  assert.deepEqual(
    ledger
      .getClipPackage(clipPackage.id)
      .assets.map(({ role, relativePath }) => ({
        role,
        relativePath,
      })),
    assets,
  );
  assert.equal(ledger.listSelectedPackages().length, 0);
  assert.equal(ledger.listPendingTreatmentRuns().length, 1);

  ledger.markTreatmentRunRendered(
    firstRun.id,
    "out/treatments/audiogram-basic/1/video-1/clip-1.mp4",
  );
  assert.equal(ledger.listPendingTreatmentRuns().length, 0);
  assert.equal(ledger.listTreatmentRuns(clipPackage.id)[0].status, "rendered");
});

test("package and treatment failures are isolated and retain their errors", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"));
  t.after(() => ledger.close());

  ledger.syncPlaylistVideos({
    playlistId: "playlist-1",
    packageVersion: "v1",
    videos: [
      { videoId: "video-1", title: "A video", url: "https://youtu.be/video-1" },
    ],
  });
  const job = ledger.getPackageJob("video-1", "v1");
  ledger.recordHeatmapSelection({
    jobId: job.id,
    heatmap: [],
    packages: [
      { rank: 1, startSeconds: 10, endSeconds: 30, score: 0.9 },
      { rank: 2, startSeconds: 40, endSeconds: 60, score: 0.8 },
    ],
  });
  const [failedPackage, readyPackage] = ledger.listClipPackages(job.id);
  ledger.markPackageFailed(failedPackage.id, "download failed");
  ledger.markPackageReady({ packageId: readyPackage.id, assets: [] });
  const run = ledger.ensureTreatmentRun({
    packageId: readyPackage.id,
    treatmentId: "audiogram-basic",
    treatmentVersion: "1",
  });
  ledger.markTreatmentRunFailed(run.id, "render failed");

  assert.equal(
    ledger.getClipPackage(failedPackage.id).lastError,
    "download failed",
  );
  assert.equal(ledger.getClipPackage(readyPackage.id).status, "ready");
  assert.equal(
    ledger.listTreatmentRuns(readyPackage.id)[0].lastError,
    "render failed",
  );

  const unsafeError = new Error(
    `--api-key secret-value ${"diagnostic".repeat(500)}`,
  );
  ledger.markPackageFailed(failedPackage.id, unsafeError);
  const persistedError = ledger.getClipPackage(failedPackage.id).lastError;
  assert.ok(persistedError.length <= 2_000);
  assert.doesNotMatch(persistedError, /secret-value/);
});

test("already-versioned malformed v1 is rejected without repair or version stamp", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ledger.sqlite");
  const malformed = new DatabaseSync(path);
  createCurrentGenericSchema(malformed, { includeTreatmentLastError: false });
  malformed.exec("PRAGMA user_version = 1");
  const schemaBefore = readSchemaSql(malformed);
  malformed.close();

  assert.throws(
    () => openAudiogramLedger(path),
    /invalid.*version 1|missing.*last_error/i,
  );

  const unchanged = new DatabaseSync(path);
  assert.deepEqual(readSchemaSql(unchanged), schemaBefore);
  assert.equal(readSchemaVersion(unchanged), 1);
  unchanged.close();
});

test("column-complete v1 with altered structural invariants is rejected unchanged", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ledger.sqlite");
  const malformed = new DatabaseSync(path);
  malformed.exec(`
    CREATE TABLE videos (
      video_id TEXT PRIMARY KEY, title TEXT NOT NULL, source_url TEXT NOT NULL,
      playlist_id TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE package_jobs (
      id INTEGER PRIMARY KEY,
      video_id TEXT NOT NULL,
      package_version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'discovered',
      heatmap_json TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE clip_packages (
      id INTEGER PRIMARY KEY,
      package_job_id INTEGER NOT NULL REFERENCES package_jobs(id) ON DELETE CASCADE,
      rank INTEGER NOT NULL CHECK (rank >= 1),
      start_seconds REAL NOT NULL CHECK (start_seconds >= 0),
      end_seconds REAL NOT NULL CHECK (end_seconds > start_seconds),
      score REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'selected'
        CHECK (status IN ('selected', 'ready', 'failed')),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (package_job_id, rank)
    ) STRICT;
    CREATE TABLE clip_assets (
      id INTEGER PRIMARY KEY,
      clip_package_id INTEGER NOT NULL REFERENCES clip_packages(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      provenance TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (clip_package_id, role)
    ) STRICT;
    CREATE TABLE treatment_runs (
      id INTEGER PRIMARY KEY,
      clip_package_id INTEGER NOT NULL REFERENCES clip_packages(id) ON DELETE CASCADE,
      treatment_id TEXT NOT NULL,
      treatment_version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'rendered', 'failed')),
      artifact_relative_path TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (clip_package_id, treatment_id, treatment_version)
    ) STRICT;
    CREATE INDEX package_jobs_status_idx ON package_jobs(status);
    CREATE INDEX clip_packages_status_idx ON clip_packages(status);
    CREATE INDEX treatment_runs_status_idx ON treatment_runs(status);
    INSERT INTO videos VALUES (
      'video-1', 'title', 'https://youtu.be/video-1', NULL,
      '${timestamp}', '${timestamp}'
    );
    INSERT INTO package_jobs VALUES (
      1, 'video-1', 'v1', 'discovered', NULL, NULL,
      '${timestamp}', '${timestamp}'
    );
    PRAGMA user_version = 1;
  `);
  const schemaBefore = readSchemaSql(malformed);
  const dataBefore = malformed.prepare("SELECT * FROM package_jobs").all();
  malformed.close();

  assert.throws(
    () => openAudiogramLedger(path),
    /invalid.*version 1.*package_jobs.*strict|structural/i,
  );

  const unchanged = new DatabaseSync(path);
  assert.deepEqual(readSchemaSql(unchanged), schemaBefore);
  assert.deepEqual(
    unchanged.prepare("SELECT * FROM package_jobs").all(),
    dataBefore,
  );
  assert.equal(readSchemaVersion(unchanged), 1);
  unchanged.close();
});

test("v1 migration preserves related rows and assigns honest terminal and unprocessed recipes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ledger.sqlite");
  const v1 = new DatabaseSync(path);
  createCurrentGenericSchema(v1);
  v1.exec(`
    INSERT INTO videos VALUES
      ('ready', 'ready', 'https://youtu.be/ready', NULL, '${timestamp}', '${timestamp}'),
      ('none', 'none', 'https://youtu.be/none', NULL, '${timestamp}', '${timestamp}'),
      ('fresh', 'fresh', 'https://youtu.be/fresh', NULL, '${timestamp}', '${timestamp}'),
      ('failed-clips', 'failed-clips', 'https://youtu.be/failed-clips', NULL, '${timestamp}', '${timestamp}'),
      ('failed-empty', 'failed-empty', 'https://youtu.be/failed-empty', NULL, '${timestamp}', '${timestamp}'),
      ('other', 'other', 'https://youtu.be/other', NULL, '${timestamp}', '${timestamp}');
    INSERT INTO package_jobs VALUES
      (1, 'ready', 'v1', 'heatmap_ready', '${JSON.stringify(heatmap)}', NULL, '${timestamp}', '${timestamp}'),
      (2, 'none', 'v1', 'no_heatmap', '[]', NULL, '${timestamp}', '${timestamp}'),
      (3, 'fresh', 'v1', 'discovered', NULL, NULL, '${timestamp}', '${timestamp}'),
      (4, 'failed-clips', 'v1', 'failed', '${JSON.stringify(heatmap)}', 'old failure', '${timestamp}', '${timestamp}'),
      (5, 'failed-empty', 'v1', 'failed', NULL, 'old failure', '${timestamp}', '${timestamp}'),
      (6, 'other', 'other-v1', 'discovered', NULL, NULL, '${timestamp}', '${timestamp}');
    INSERT INTO clip_packages VALUES
      (10, 1, 1, 10, 30, 0.9, 'ready', NULL, '${timestamp}', '${timestamp}'),
      (11, 4, 1, 10, 30, 0.9, 'failed', 'old clip failure', '${timestamp}', '${timestamp}');
    INSERT INTO clip_assets VALUES
      (20, 10, 'audio', 'public/generated/ready/v1/clip-1/audio.wav', 'yt-dlp', '{"codec":"wav"}', '${timestamp}', '${timestamp}');
    INSERT INTO treatment_runs VALUES
      (30, 10, 'audiogram-basic', '1', 'rendered', 'out/ready.mp4', NULL, '${timestamp}', '${timestamp}');
    PRAGMA user_version = 1;
  `);
  v1.close();

  const ledger = openAudiogramLedger(path, {
    selectionRecipe: transcriptRecipe,
    packageVersion: "v1",
  });
  assert.equal(ledger.getSchemaVersion(), 2);
  assert.equal(ledger.getPackageJob("ready", "v1").status, "selection_ready");
  assert.equal(ledger.getPackageJob("none", "v1").status, "no_selection");
  assert.equal(
    ledger.getPackageJob("fresh", "v1").selectionRecipeSha256,
    transcriptRecipe.sha256,
  );
  assert.equal(
    ledger.getPackageJob("failed-empty", "v1").selectionRecipeSha256,
    transcriptRecipe.sha256,
  );
  assert.equal(ledger.getSelectionRun(3), null);
  assert.equal(ledger.getSelectionRun(5), null);
  assert.equal(ledger.getSelectionRun(6), null);
  assert.deepEqual(
    JSON.parse(ledger.getPackageJob("other", "other-v1").selectionRecipeJson),
    legacyUnknownRecipe,
  );
  for (const jobId of [1, 2, 4]) {
    const run = ledger.getSelectionRun(jobId);
    assert.equal(run.selectorId, "youtube-heatmap-legacy");
    assert.equal(run.selectorVersion, "0");
    assert.equal(run.transcriptId, null);
  }
  assert.deepEqual(ledger.getSelectionRun(1).result, {
    schemaVersion: 1,
    heatmap,
    clips: heatmapPackages,
  });
  assert.equal(
    ledger.getClipPackage(10).assets[0].relativePath,
    "public/generated/ready/v1/clip-1/audio.wav",
  );
  assert.equal(
    ledger.listTreatmentRuns(10)[0].artifactRelativePath,
    "out/ready.mp4",
  );
  ledger.close();

  const migrated = new DatabaseSync(path);
  assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(readSchemaVersion(migrated), 2);
  migrated.close();
});

test("mapped v1 terminal jobs use exact normal heatmap recipes and mappings are strict", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const makeV1 = (name) => {
    const path = join(directory, `${name}.sqlite`);
    const database = new DatabaseSync(path);
    createCurrentGenericSchema(database);
    database.exec(`
      INSERT INTO videos VALUES ('video-1', 'title', 'https://youtu.be/video-1', NULL, '${timestamp}', '${timestamp}');
      INSERT INTO package_jobs VALUES (1, 'video-1', 'v1', 'heatmap_ready', '${JSON.stringify(heatmap)}', NULL, '${timestamp}', '${timestamp}');
      INSERT INTO clip_packages VALUES (1, 1, 1, 10, 30, 0.9, 'selected', NULL, '${timestamp}', '${timestamp}');
      PRAGMA user_version = 1;
    `);
    database.close();
    return path;
  };

  const mappedPath = makeV1("mapped");
  const mappedRecipe = buildSelectionRecipe({
    selectorId: "youtube-heatmap",
    maxClips: 4,
    minimumSeparationMs: 12_345,
  });
  const mapped = openAudiogramLedger(mappedPath, {
    selectionRecipe: defaultHeatmapRecipe,
    packageVersion: "v2",
    legacyHeatmapRecipeMap: {
      v1: { maxClips: 4, minimumSeparationMs: 12_345 },
    },
  });
  assert.equal(
    mapped.getPackageJob("video-1", "v1").selectionRecipeSha256,
    mappedRecipe.sha256,
  );
  assert.equal(mapped.getSelectionRun(1).selectorId, "youtube-heatmap");
  mapped.close();

  for (const [name, mapping] of [
    ["absent", { absent: { maxClips: 1, minimumSeparationMs: 0 } }],
    ["unknown-key", { v1: { maxClips: 1, minimumSeparationMs: 0, extra: 1 } }],
    ["invalid-value", { v1: { maxClips: 0, minimumSeparationMs: 0 } }],
  ]) {
    const path = makeV1(name);
    assert.throws(
      () =>
        openAudiogramLedger(path, {
          selectionRecipe: defaultHeatmapRecipe,
          packageVersion: "v2",
          legacyHeatmapRecipeMap: mapping,
        }),
      /legacy heatmap recipe mapping|absent package version/i,
    );
    const unchanged = new DatabaseSync(path);
    assert.equal(readSchemaVersion(unchanged), 1);
    assert.equal(
      unchanged.prepare("SELECT COUNT(*) AS count FROM package_jobs").get()
        .count,
      1,
    );
    unchanged.close();
  }
});

test("migration rolls back invalid completed heatmap provenance before stamping v2", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ledger.sqlite");
  const v1 = new DatabaseSync(path);
  createCurrentGenericSchema(v1);
  v1.exec(`
    INSERT INTO videos VALUES ('video-1', 'title', 'https://youtu.be/video-1', NULL, '${timestamp}', '${timestamp}');
    INSERT INTO package_jobs VALUES (1, 'video-1', 'v1', 'heatmap_ready', '{bad', NULL, '${timestamp}', '${timestamp}');
    PRAGMA user_version = 1;
  `);
  const schemaBefore = readSchemaSql(v1);
  v1.close();

  assert.throws(() => openAudiogramLedger(path), /heatmap|JSON|migration/i);
  const unchanged = new DatabaseSync(path);
  assert.deepEqual(readSchemaSql(unchanged), schemaBefore);
  assert.equal(readSchemaVersion(unchanged), 1);
  unchanged.close();
});

test("sync rejects every changed recipe dimension under one package version", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"), {
    selectionRecipe: transcriptRecipe,
  });
  t.after(() => ledger.close());
  const video = {
    videoId: "video-1",
    title: "title",
    url: "https://youtu.be/video-1",
  };
  ledger.syncPlaylistVideos({
    playlistId: "playlist-1",
    packageVersion: "transcript-v1",
    selectionRecipe: transcriptRecipe,
    videos: [video],
  });

  const base = {
    selectorId: "transcript-llm",
    providerId: "openai-api",
    desiredClipCount: 3,
  };
  const changedRecipes = [
    recipeEnvelope({
      ...transcriptRecipe.recipe,
      selector: { ...transcriptRecipe.recipe.selector, version: "2" },
    }),
    buildSelectionRecipe({ ...base, providerId: "chatgpt-oauth" }),
    buildSelectionRecipe({ ...base, model: "changed-model" }),
    buildSelectionRecipe({ ...base, promptVersion: "changed-prompt" }),
    buildSelectionRecipe({ ...base, prompt: "changed prompt body" }),
    buildSelectionRecipe({ ...base, outputSchemaVersion: 2 }),
    buildSelectionRecipe({ ...base, outputSchema: { type: "object" } }),
    buildSelectionRecipe({ ...base, desiredClipCount: 4 }),
    ...[
      "minimumClipMs",
      "maximumClipMs",
      "minimumSeparationMs",
      "leadingPaddingMs",
      "trailingPaddingMs",
      "maximumTranscriptUtf8Bytes",
      "maximumNetworkResponseBytes",
      "maximumOutputTextUtf8Bytes",
      "officialMaximumOutputTokens",
    ].map((key) =>
      buildSelectionRecipe({
        ...base,
        limits: {
          ...transcriptRecipe.recipe.limits,
          [key]: transcriptRecipe.recipe.limits[key] + 1,
        },
      }),
    ),
    defaultHeatmapRecipe,
  ];
  for (const selectionRecipe of changedRecipes)
    assert.throws(
      () =>
        ledger.syncPlaylistVideos({
          playlistId: "playlist-1",
          packageVersion: "transcript-v1",
          selectionRecipe,
          videos: [video],
        }),
      /selection recipe.*package version|new.*package version/i,
    );
});

test("sync rejects malformed stored recipe identity and explains legacy unknown mismatches", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ledger.sqlite");
  let ledger = openAudiogramLedger(path);
  ledger.syncPlaylistVideos({
    playlistId: "playlist-1",
    packageVersion: "v1",
    videos: [
      { videoId: "video-1", title: "title", url: "https://youtu.be/video-1" },
    ],
  });
  ledger.close();
  const corrupt = new DatabaseSync(path);
  corrupt
    .prepare(
      "UPDATE package_jobs SET selection_recipe_sha256 = 'bad' WHERE id = 1",
    )
    .run();
  corrupt.close();
  ledger = openAudiogramLedger(path);
  assert.throws(
    () =>
      ledger.syncPlaylistVideos({
        playlistId: "playlist-1",
        packageVersion: "v1",
        videos: [
          {
            videoId: "video-1",
            title: "title",
            url: "https://youtu.be/video-1",
          },
        ],
      }),
    /recipe.*hash|canonical/i,
  );
  ledger.close();

  const legacyPath = join(directory, "legacy.sqlite");
  const v1 = new DatabaseSync(legacyPath);
  createCurrentGenericSchema(v1);
  v1.exec(`
    INSERT INTO videos VALUES ('video-2', 'title', 'https://youtu.be/video-2', NULL, '${timestamp}', '${timestamp}');
    INSERT INTO package_jobs VALUES (1, 'video-2', 'v1', 'no_heatmap', '[]', NULL, '${timestamp}', '${timestamp}');
    PRAGMA user_version = 1;
  `);
  v1.close();
  ledger = openAudiogramLedger(legacyPath);
  t.after(() => ledger.close());
  assert.throws(
    () =>
      ledger.syncPlaylistVideos({
        playlistId: "playlist-1",
        packageVersion: "v1",
        selectionRecipe: widerHeatmapRecipe,
        videos: [
          {
            videoId: "video-2",
            title: "title",
            url: "https://youtu.be/video-2",
          },
        ],
      }),
    /prior settings.*unknowable.*new.*AUDIOGRAM_PACKAGE_VERSION/i,
  );
});

test("new heatmap selections persist exact recipes, schema identity, results, and statuses", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"), {
    selectionRecipe: defaultHeatmapRecipe,
  });
  t.after(() => ledger.close());
  const video = {
    videoId: "video-1",
    title: "title",
    url: "https://youtu.be/video-1",
  };
  for (const [packageVersion, selectionRecipe] of [
    ["v1", defaultHeatmapRecipe],
    ["v2", widerHeatmapRecipe],
  ]) {
    ledger.syncPlaylistVideos({
      playlistId: "playlist-1",
      packageVersion,
      selectionRecipe,
      videos: [video],
    });
    const job = ledger.getPackageJob("video-1", packageVersion);
    ledger.recordHeatmapSelection({
      jobId: job.id,
      selectionRecipe,
      heatmap: packageVersion === "v1" ? heatmap : [],
      packages: packageVersion === "v1" ? heatmapPackages : [],
    });
    const run = ledger.getSelectionRun(job.id);
    assert.equal(run.selectorId, "youtube-heatmap");
    assert.equal(run.outputSchemaSha256, HEATMAP_SCHEMA_SHA256);
    assert.deepEqual(run.result, {
      schemaVersion: 1,
      heatmap: packageVersion === "v1" ? heatmap : [],
      clips: packageVersion === "v1" ? heatmapPackages : [],
    });
    assert.equal(
      ledger.getPackageJob("video-1", packageVersion).status,
      packageVersion === "v1" ? "selection_ready" : "no_selection",
    );
    assert.equal(
      ledger.getPackageJob("video-1", packageVersion).selectionRecipeSha256,
      selectionRecipe.sha256,
    );
  }
  for (const selectionRecipe of [
    buildSelectionRecipe({
      selectorId: "youtube-heatmap",
      maxClips: 2,
      minimumSeparationMs: 20_000,
    }),
    buildSelectionRecipe({
      selectorId: "youtube-heatmap",
      maxClips: 1,
      minimumSeparationMs: 20_001,
    }),
  ])
    assert.throws(
      () =>
        ledger.syncPlaylistVideos({
          playlistId: "playlist-1",
          packageVersion: "v1",
          selectionRecipe,
          videos: [video],
        }),
      /selection recipe.*package version|new.*package version/i,
    );
});

test("transcript selection atomically persists one transcript, provenance, packages, and lookup", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ledger.sqlite");
  let ledger = openAudiogramLedger(path, { selectionRecipe: transcriptRecipe });
  ledger.syncPlaylistVideos({
    playlistId: "playlist-1",
    packageVersion: "transcript-v1",
    selectionRecipe: transcriptRecipe,
    videos: [
      { videoId: "video-1", title: "title", url: "https://youtu.be/video-1" },
    ],
  });
  const job = ledger.getPackageJob("video-1", "transcript-v1");
  ledger.recordTranscriptSelection({
    jobId: job.id,
    transcript,
    result: transcriptResult,
    packages: [{ rank: 1, startMs: 0, endMs: 31_000, score: 0.9 }],
    provenance: {
      providerId: "openai-api",
      model: transcriptRecipe.recipe.provider.model,
      responseId: "resp_123",
      recipeSha256: transcriptRecipe.sha256,
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    },
    selectionRecipe: transcriptRecipe,
  });
  const [clipPackage] = ledger.listClipPackages(job.id);
  assert.equal(
    ledger.getPackageJob("video-1", "transcript-v1").status,
    "selection_ready",
  );
  assert.deepEqual(ledger.getSelectionRun(job.id).usage, {
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
  });
  const stored = ledger.getTranscriptForPackage(clipPackage.id);
  assert.equal(stored.sha256, transcript.sha256);
  assert.deepEqual(stored.cues, transcript.cues);
  assert.deepEqual(ledger.getTranscript(stored.id), stored);
  assert.equal("cues" in ledger.listSelectedPackages()[0], false);
  ledger.close();

  ledger = openAudiogramLedger(path, { selectionRecipe: transcriptRecipe });
  t.after(() => ledger.close());
  assert.equal(
    ledger.getTranscriptForPackage(clipPackage.id).sha256,
    transcript.sha256,
  );

  ledger.syncPlaylistVideos({
    playlistId: "playlist-1",
    packageVersion: "heatmap-v1",
    selectionRecipe: defaultHeatmapRecipe,
    videos: [
      { videoId: "video-1", title: "title", url: "https://youtu.be/video-1" },
    ],
  });
  const heatmapJob = ledger.getPackageJob("video-1", "heatmap-v1");
  ledger.recordHeatmapSelection({
    jobId: heatmapJob.id,
    selectionRecipe: defaultHeatmapRecipe,
    heatmap,
    packages: heatmapPackages,
  });
  assert.equal(
    ledger.getTranscriptForPackage(
      ledger.listClipPackages(heatmapJob.id)[0].id,
    ),
    null,
  );
});

test("transcript reads recompute persisted identity and failed writes roll back atomically", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ledger.sqlite");
  let ledger = openAudiogramLedger(path, { selectionRecipe: transcriptRecipe });
  ledger.syncPlaylistVideos({
    playlistId: "playlist-1",
    packageVersion: "transcript-v1",
    selectionRecipe: transcriptRecipe,
    videos: [
      { videoId: "video-1", title: "title", url: "https://youtu.be/video-1" },
    ],
  });
  const job = ledger.getPackageJob("video-1", "transcript-v1");
  assert.throws(
    () =>
      ledger.recordTranscriptSelection({
        jobId: job.id,
        transcript: { ...transcript, sha256: "wrong" },
        result: transcriptResult,
        packages: [{ rank: 1, startMs: 0, endMs: 31_000, score: 0.9 }],
        provenance: {
          providerId: "openai-api",
          model: transcriptRecipe.recipe.provider.model,
          recipeSha256: transcriptRecipe.sha256,
        },
        selectionRecipe: transcriptRecipe,
      }),
    /transcript.*identity|sha256/i,
  );
  assert.equal(ledger.getSelectionRun(job.id), null);
  assert.deepEqual(ledger.listClipPackages(job.id), []);
  ledger.recordTranscriptSelection({
    jobId: job.id,
    transcript,
    result: transcriptResult,
    packages: [{ rank: 1, startMs: 0, endMs: 31_000, score: 0.9 }],
    provenance: {
      providerId: "openai-api",
      model: transcriptRecipe.recipe.provider.model,
      recipeSha256: transcriptRecipe.sha256,
    },
    selectionRecipe: transcriptRecipe,
  });
  const transcriptId = ledger.getSelectionRun(job.id).transcriptId;
  ledger.close();

  const corrupt = new DatabaseSync(path);
  corrupt
    .prepare("UPDATE transcripts SET content_sha256 = 'bad' WHERE id = ?")
    .run(transcriptId);
  corrupt.close();
  ledger = openAudiogramLedger(path, { selectionRecipe: transcriptRecipe });
  t.after(() => ledger.close());
  assert.throws(
    () => ledger.getTranscript(transcriptId),
    /transcript.*identity|sha256/i,
  );
});

test("completed selections cannot be re-recorded over ready or failed package state", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = openAudiogramLedger(join(directory, "ledger.sqlite"));
  t.after(() => ledger.close());

  ledger.syncPlaylistVideos({
    playlistId: "playlist-1",
    packageVersion: "heatmap-v1",
    selectionRecipe: defaultHeatmapRecipe,
    videos: [
      { videoId: "heatmap", title: "heatmap", url: "https://youtu.be/heatmap" },
    ],
  });
  const heatmapJob = ledger.getPackageJob("heatmap", "heatmap-v1");
  ledger.recordHeatmapSelection({
    jobId: heatmapJob.id,
    selectionRecipe: defaultHeatmapRecipe,
    heatmap,
    packages: heatmapPackages,
  });
  const [readyPackage] = ledger.listClipPackages(heatmapJob.id);
  ledger.markPackageReady({
    packageId: readyPackage.id,
    assets: [{ role: "audio", relativePath: "public/generated/audio.wav" }],
  });
  const originalHeatmapRun = ledger.getSelectionRun(heatmapJob.id);

  assert.throws(
    () =>
      ledger.recordHeatmapSelection({
        jobId: heatmapJob.id,
        selectionRecipe: defaultHeatmapRecipe,
        heatmap: [],
        packages: [],
      }),
    /selection.*already.*completed|immutable/i,
  );
  assert.equal(
    ledger.getPackageJob("heatmap", "heatmap-v1").status,
    "selection_ready",
  );
  assert.deepEqual(ledger.getSelectionRun(heatmapJob.id), originalHeatmapRun);
  assert.equal(ledger.getClipPackage(readyPackage.id).status, "ready");
  assert.equal(ledger.getClipPackage(readyPackage.id).assets.length, 1);

  ledger.syncPlaylistVideos({
    playlistId: "playlist-1",
    packageVersion: "transcript-v1",
    selectionRecipe: transcriptRecipe,
    videos: [
      {
        videoId: "transcript",
        title: "transcript",
        url: "https://youtu.be/transcript",
      },
    ],
  });
  const transcriptJob = ledger.getPackageJob("transcript", "transcript-v1");
  ledger.recordTranscriptSelection({
    jobId: transcriptJob.id,
    transcript,
    result: transcriptResult,
    packages: [{ rank: 1, startMs: 0, endMs: 31_000, score: 0.9 }],
    provenance: {
      providerId: "openai-api",
      model: transcriptRecipe.recipe.provider.model,
      recipeSha256: transcriptRecipe.sha256,
    },
    selectionRecipe: transcriptRecipe,
  });
  const [failedPackage] = ledger.listClipPackages(transcriptJob.id);
  ledger.markPackageFailed(failedPackage.id, "download failed");
  const originalTranscriptRun = ledger.getSelectionRun(transcriptJob.id);

  assert.throws(
    () =>
      ledger.recordTranscriptSelection({
        jobId: transcriptJob.id,
        transcript,
        result: transcriptResult,
        packages: [],
        provenance: {
          providerId: "openai-api",
          model: transcriptRecipe.recipe.provider.model,
          recipeSha256: transcriptRecipe.sha256,
        },
        selectionRecipe: transcriptRecipe,
      }),
    /selection.*already.*completed|immutable/i,
  );
  assert.equal(
    ledger.getPackageJob("transcript", "transcript-v1").status,
    "selection_ready",
  );
  assert.deepEqual(
    ledger.getSelectionRun(transcriptJob.id),
    originalTranscriptRun,
  );
  assert.equal(ledger.getClipPackage(failedPackage.id).status, "failed");
  assert.equal(
    ledger.getClipPackage(failedPackage.id).lastError,
    "download failed",
  );
});
