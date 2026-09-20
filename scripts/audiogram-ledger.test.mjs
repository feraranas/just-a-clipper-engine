import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import * as audiogramLedger from "./audiogram-ledger.mjs";

const { openAudiogramLedger } = audiogramLedger;

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
      1, 'video-1', 'v1', 'heatmap_ready', '[{"value":0.9}]', NULL,
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

  let ledger = openAudiogramLedger(path);
  t.after(() => ledger?.close());

  const job = ledger.getPackageJob("video-1", "v1");
  assert.equal(job.status, "heatmap_ready");
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
  assert.equal(ledger.getSchemaVersion(), 1);

  ledger.close();
  ledger = null;
  const migrated = new DatabaseSync(path);
  assert.equal(readSchemaVersion(migrated), 1);
  migrated.close();
});

test("fresh database schema version 1 creates all application tables", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ledger.sqlite");

  const ledger = openAudiogramLedger(path);
  assert.equal(audiogramLedger.AUDIOGRAM_SCHEMA_VERSION, 1);
  assert.equal(ledger.getSchemaVersion(), 1);
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
      "clip_assets",
      "clip_packages",
      "package_jobs",
      "treatment_runs",
      "videos",
    ],
  );
  assert.equal(readSchemaVersion(database), 1);
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
  assert.equal(ledger.getSchemaVersion(), 1);
  assert.equal(ledger.getPackageJob("video-1", "v1").status, "heatmap_ready");
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
  assert.deepEqual(readSchemaSql(adopted), schemaBefore);
  assert.equal(readSchemaVersion(adopted), 1);
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
  assert.equal(ledger.getSchemaVersion(), 1);
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
  assert.deepEqual(
    readSchemaSql(adopted).filter(({ name }) => name !== "clip_assets"),
    otherSchemaBefore,
  );
  assert.equal(readSchemaVersion(adopted), 1);
  adopted.close();
});

test("too-new schema version is rejected without changing schema SQL", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "audiogram-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "ledger.sqlite");
  const tooNew = new DatabaseSync(path);
  createCurrentGenericSchema(tooNew);
  tooNew.exec("PRAGMA user_version = 2");
  const schemaBefore = readSchemaSql(tooNew);
  tooNew.close();

  assert.throws(
    () => openAudiogramLedger(path),
    /schema version 2|unsupported|newer/i,
  );

  const unchanged = new DatabaseSync(path);
  assert.deepEqual(readSchemaSql(unchanged), schemaBefore);
  assert.equal(readSchemaVersion(unchanged), 2);
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
  assert.equal(ledger.getPackageJob("video-1", "v1").status, "heatmap_ready");
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
