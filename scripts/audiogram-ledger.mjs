import { DatabaseSync } from "node:sqlite";

import { sanitizeErrorDiagnostic } from "./error-diagnostics.mjs";

export const AUDIOGRAM_SCHEMA_VERSION = 1;

const LEGACY_TABLES = ["processing_jobs", "clips"];
const GENERIC_TABLES = [
  "package_jobs",
  "clip_packages",
  "clip_assets",
  "treatment_runs",
];
const REQUIRED_SCHEMA_VERSION_1_COLUMNS = {
  videos: [
    "video_id",
    "title",
    "source_url",
    "playlist_id",
    "first_seen_at",
    "last_seen_at",
  ],
  package_jobs: [
    "id",
    "video_id",
    "package_version",
    "status",
    "heatmap_json",
    "last_error",
    "created_at",
    "updated_at",
  ],
  clip_packages: [
    "id",
    "package_job_id",
    "rank",
    "start_seconds",
    "end_seconds",
    "score",
    "status",
    "last_error",
    "created_at",
    "updated_at",
  ],
  clip_assets: [
    "id",
    "clip_package_id",
    "role",
    "relative_path",
    "provenance",
    "metadata_json",
    "created_at",
    "updated_at",
  ],
  treatment_runs: [
    "id",
    "clip_package_id",
    "treatment_id",
    "treatment_version",
    "status",
    "artifact_relative_path",
    "last_error",
    "created_at",
    "updated_at",
  ],
};

const mapVideo = (row) =>
  row
    ? {
        videoId: row.video_id,
        title: row.title,
        sourceUrl: row.source_url,
        playlistId: row.playlist_id,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      }
    : null;

const mapPackageJob = (row) =>
  row
    ? {
        id: row.id,
        videoId: row.video_id,
        packageVersion: row.package_version,
        status: row.status,
        heatmapJson: row.heatmap_json,
        lastError: row.last_error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

const mapClipPackage = (row) => ({
  id: row.id,
  packageJobId: row.package_job_id,
  rank: row.rank,
  startSeconds: row.start_seconds,
  endSeconds: row.end_seconds,
  score: row.score,
  status: row.status,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapAsset = (row) => ({
  id: row.id,
  clipPackageId: row.clip_package_id,
  role: row.role,
  relativePath: row.relative_path,
  provenance: row.provenance,
  metadataJson: row.metadata_json,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapTreatmentRun = (row) => ({
  id: row.id,
  clipPackageId: row.clip_package_id,
  treatmentId: row.treatment_id,
  treatmentVersion: row.treatment_version,
  status: row.status,
  artifactRelativePath: row.artifact_relative_path,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const tableExists = (database, name) =>
  Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );

const readSchemaVersion = (database) =>
  database.prepare("PRAGMA user_version").get().user_version;

const classifyUnversionedSchema = (database) => {
  const presentLegacyTables = LEGACY_TABLES.filter((name) =>
    tableExists(database, name),
  );
  const presentGenericTables = GENERIC_TABLES.filter((name) =>
    tableExists(database, name),
  );

  if (presentLegacyTables.length === 0 && presentGenericTables.length === 0) {
    return "fresh";
  }
  if (
    presentLegacyTables.length === LEGACY_TABLES.length &&
    presentGenericTables.length === 0
  ) {
    return "legacy";
  }
  if (
    presentLegacyTables.length === 0 &&
    presentGenericTables.length === GENERIC_TABLES.length
  ) {
    return "generic";
  }

  const missingLegacyTables = LEGACY_TABLES.filter(
    (name) => !presentLegacyTables.includes(name),
  );
  const missingGenericTables = GENERIC_TABLES.filter(
    (name) => !presentGenericTables.includes(name),
  );
  throw new Error(
    `Ambiguous or incomplete unversioned audiogram schema: ` +
      `present legacy tables [${presentLegacyTables.join(", ")}], ` +
      `missing legacy tables [${missingLegacyTables.join(", ")}], ` +
      `present generic tables [${presentGenericTables.join(", ")}], ` +
      `missing generic tables [${missingGenericTables.join(", ")}]`,
  );
};

const createGenericTables = (database) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      video_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_url TEXT NOT NULL,
      playlist_id TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS package_jobs (
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

    CREATE TABLE IF NOT EXISTS clip_packages (
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

    CREATE TABLE IF NOT EXISTS clip_assets (
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

    CREATE TABLE IF NOT EXISTS treatment_runs (
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

    CREATE INDEX IF NOT EXISTS package_jobs_status_idx ON package_jobs(status);
    CREATE INDEX IF NOT EXISTS clip_packages_status_idx ON clip_packages(status);
    CREATE INDEX IF NOT EXISTS treatment_runs_status_idx ON treatment_runs(status);
  `);
};

const migrateLegacyTables = (database) => {
  createGenericTables(database);
  database.exec(`
    INSERT INTO package_jobs (
      id, video_id, package_version, status, heatmap_json, last_error,
      created_at, updated_at
    )
    SELECT id, video_id, treatment_version,
      CASE status WHEN 'rendered' THEN 'heatmap_ready' ELSE status END,
      heatmap_json, last_error, created_at, updated_at
    FROM processing_jobs;

    INSERT INTO clip_packages (
      id, package_job_id, rank, start_seconds, end_seconds, score, status,
      last_error, created_at, updated_at
    )
    SELECT id, processing_job_id, rank, start_seconds, end_seconds, score,
      CASE status
        WHEN 'media_ready' THEN 'ready'
        WHEN 'rendered' THEN 'ready'
        ELSE status
      END,
      NULL, created_at, updated_at
    FROM clips;

    INSERT INTO treatment_runs (
      clip_package_id, treatment_id, treatment_version, status,
      artifact_relative_path, last_error, created_at, updated_at
    )
    SELECT id, 'audiogram-basic', '1', 'rendered', artifact_relative_path,
      NULL, created_at, updated_at
    FROM clips WHERE artifact_relative_path IS NOT NULL;
  `);

  const legacyJobCount = database
    .prepare("SELECT COUNT(*) AS count FROM processing_jobs")
    .get().count;
  const packageJobCount = database
    .prepare("SELECT COUNT(*) AS count FROM package_jobs")
    .get().count;
  const legacyClipCount = database
    .prepare("SELECT COUNT(*) AS count FROM clips")
    .get().count;
  const packageCount = database
    .prepare("SELECT COUNT(*) AS count FROM clip_packages")
    .get().count;
  if (legacyJobCount !== packageJobCount || legacyClipCount !== packageCount) {
    throw new Error("Legacy ledger migration row-count validation failed");
  }

  database.exec("DROP TABLE clips; DROP TABLE processing_jobs;");
};

const ensureClipAssetColumns = (database) => {
  const columns = new Set(
    database
      .prepare("PRAGMA table_info(clip_assets)")
      .all()
      .map(({ name }) => name),
  );
  if (!columns.has("provenance")) {
    database.exec("ALTER TABLE clip_assets ADD COLUMN provenance TEXT");
  }
  if (!columns.has("metadata_json")) {
    database.exec("ALTER TABLE clip_assets ADD COLUMN metadata_json TEXT");
  }
};

const validateSchemaVersion1 = (database) => {
  for (const [table, requiredColumns] of Object.entries(
    REQUIRED_SCHEMA_VERSION_1_COLUMNS,
  )) {
    if (!tableExists(database, table)) {
      throw new Error(
        `Invalid audiogram schema version 1: missing table ${table}`,
      );
    }
    const presentColumns = new Set(
      database
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map(({ name }) => name),
    );
    const missingColumns = requiredColumns.filter(
      (column) => !presentColumns.has(column),
    );
    if (missingColumns.length > 0) {
      throw new Error(
        `Invalid audiogram schema version 1: table ${table} missing columns ` +
          missingColumns.join(", "),
      );
    }
  }
};

const migrateSchema = (database) => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const classification = classifyUnversionedSchema(database);
    if (classification === "fresh") {
      createGenericTables(database);
    } else if (classification === "legacy") {
      migrateLegacyTables(database);
    } else {
      ensureClipAssetColumns(database);
    }

    validateSchemaVersion1(database);
    database.exec(`PRAGMA user_version = ${AUDIOGRAM_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

export const openAudiogramLedger = (
  path,
  { now = () => new Date().toISOString() } = {},
) => {
  const database = new DatabaseSync(path, { timeout: 5_000 });
  try {
    const schemaVersion = readSchemaVersion(database);
    if (schemaVersion > AUDIOGRAM_SCHEMA_VERSION) {
      throw new Error(
        `Audiogram schema version ${schemaVersion} is newer than supported ` +
          `version ${AUDIOGRAM_SCHEMA_VERSION}`,
      );
    }
    if (schemaVersion < 0) {
      throw new Error(`Unsupported audiogram schema version ${schemaVersion}`);
    }

    database.exec("PRAGMA foreign_keys = ON");
    if (schemaVersion === 0) {
      migrateSchema(database);
    } else {
      validateSchemaVersion1(database);
    }
    database.exec("PRAGMA journal_mode = WAL");
  } catch (error) {
    database.close();
    throw error;
  }

  const getVideoStatement = database.prepare(
    "SELECT * FROM videos WHERE video_id = ?",
  );
  const getPackageJobStatement = database.prepare(
    "SELECT * FROM package_jobs WHERE video_id = ? AND package_version = ?",
  );

  const syncPlaylistVideos = ({ playlistId, packageVersion, videos }) => {
    let discovered = 0;
    let existing = 0;
    const timestamp = now();
    database.exec("BEGIN IMMEDIATE");
    try {
      const upsertVideo = database.prepare(`
        INSERT INTO videos (
          video_id, title, source_url, playlist_id, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(video_id) DO UPDATE SET
          title = excluded.title,
          source_url = excluded.source_url,
          playlist_id = excluded.playlist_id,
          last_seen_at = excluded.last_seen_at
      `);
      const createJob = database.prepare(`
        INSERT INTO package_jobs (
          video_id, package_version, status, created_at, updated_at
        ) VALUES (?, ?, 'discovered', ?, ?)
        ON CONFLICT(video_id, package_version) DO NOTHING
      `);
      for (const video of videos) {
        if (getVideoStatement.get(video.videoId)) existing += 1;
        else discovered += 1;
        upsertVideo.run(
          video.videoId,
          video.title,
          video.url,
          playlistId,
          timestamp,
          timestamp,
        );
        createJob.run(video.videoId, packageVersion, timestamp, timestamp);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return { discovered, existing };
  };

  const recordHeatmapSelection = ({ jobId, heatmap, packages }) => {
    const timestamp = now();
    const status = packages.length > 0 ? "heatmap_ready" : "no_heatmap";
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          `
        UPDATE package_jobs
        SET status = ?, heatmap_json = ?, last_error = NULL, updated_at = ?
        WHERE id = ?
      `,
        )
        .run(status, JSON.stringify(heatmap), timestamp, jobId);
      database
        .prepare(
          "DELETE FROM clip_packages WHERE package_job_id = ? AND status = 'selected'",
        )
        .run(jobId);
      const insertPackage = database.prepare(`
        INSERT INTO clip_packages (
          package_job_id, rank, start_seconds, end_seconds, score,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'selected', ?, ?)
        ON CONFLICT(package_job_id, rank) DO UPDATE SET
          start_seconds = excluded.start_seconds,
          end_seconds = excluded.end_seconds,
          score = excluded.score,
          updated_at = excluded.updated_at
      `);
      for (const clipPackage of packages) {
        insertPackage.run(
          jobId,
          clipPackage.rank,
          clipPackage.startSeconds,
          clipPackage.endSeconds,
          clipPackage.score,
          timestamp,
          timestamp,
        );
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const listAssets = (packageId) =>
    database
      .prepare(
        "SELECT * FROM clip_assets WHERE clip_package_id = ? ORDER BY role",
      )
      .all(packageId)
      .map(mapAsset);

  return {
    close: () => database.close(),
    countPackageJobs: () =>
      database.prepare("SELECT COUNT(*) AS count FROM package_jobs").get()
        .count,
    countVideos: () =>
      database.prepare("SELECT COUNT(*) AS count FROM videos").get().count,
    ensureTreatmentRun: ({ packageId, treatmentId, treatmentVersion }) => {
      const timestamp = now();
      database
        .prepare(
          `
        INSERT INTO treatment_runs (
          clip_package_id, treatment_id, treatment_version, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(clip_package_id, treatment_id, treatment_version) DO NOTHING
      `,
        )
        .run(packageId, treatmentId, treatmentVersion, timestamp, timestamp);
      return mapTreatmentRun(
        database
          .prepare(
            `
        SELECT * FROM treatment_runs
        WHERE clip_package_id = ? AND treatment_id = ? AND treatment_version = ?
      `,
          )
          .get(packageId, treatmentId, treatmentVersion),
      );
    },
    getClipPackage: (packageId) => {
      const row = database
        .prepare(
          `
        SELECT clip_packages.*, package_jobs.video_id, package_jobs.package_version,
               videos.title, videos.source_url
        FROM clip_packages
        JOIN package_jobs ON package_jobs.id = clip_packages.package_job_id
        JOIN videos ON videos.video_id = package_jobs.video_id
        WHERE clip_packages.id = ?
      `,
        )
        .get(packageId);
      return row
        ? {
            ...mapClipPackage(row),
            videoId: row.video_id,
            packageVersion: row.package_version,
            title: row.title,
            sourceUrl: row.source_url,
            assets: listAssets(row.id),
          }
        : null;
    },
    getPackageJob: (videoId, packageVersion) =>
      mapPackageJob(getPackageJobStatement.get(videoId, packageVersion)),
    getSchemaVersion: () => readSchemaVersion(database),
    getVideo: (videoId) => mapVideo(getVideoStatement.get(videoId)),
    listClipPackages: (jobId) =>
      database
        .prepare(
          "SELECT * FROM clip_packages WHERE package_job_id = ? ORDER BY rank",
        )
        .all(jobId)
        .map(mapClipPackage),
    listPendingPackageJobs: () =>
      database
        .prepare(
          `
        SELECT package_jobs.*, videos.title, videos.source_url
        FROM package_jobs JOIN videos USING (video_id)
        WHERE package_jobs.status = 'discovered'
        ORDER BY package_jobs.id
      `,
        )
        .all()
        .map((row) => ({
          ...mapPackageJob(row),
          title: row.title,
          sourceUrl: row.source_url,
        })),
    listPendingTreatmentRuns: () =>
      database
        .prepare(
          `
        SELECT treatment_runs.*, clip_packages.rank,
               package_jobs.video_id, package_jobs.package_version,
               videos.title, videos.source_url
        FROM treatment_runs
        JOIN clip_packages ON clip_packages.id = treatment_runs.clip_package_id
        JOIN package_jobs ON package_jobs.id = clip_packages.package_job_id
        JOIN videos ON videos.video_id = package_jobs.video_id
        WHERE treatment_runs.status = 'pending'
        ORDER BY treatment_runs.id
      `,
        )
        .all()
        .map((row) => ({
          ...mapTreatmentRun(row),
          rank: row.rank,
          videoId: row.video_id,
          packageVersion: row.package_version,
          title: row.title,
          sourceUrl: row.source_url,
          assets: listAssets(row.clip_package_id),
        })),
    listReadyPackages: () =>
      database
        .prepare(
          `
        SELECT clip_packages.*, package_jobs.video_id, package_jobs.package_version,
               videos.title, videos.source_url
        FROM clip_packages
        JOIN package_jobs ON package_jobs.id = clip_packages.package_job_id
        JOIN videos ON videos.video_id = package_jobs.video_id
        WHERE clip_packages.status = 'ready'
        ORDER BY clip_packages.id
      `,
        )
        .all()
        .map((row) => ({
          ...mapClipPackage(row),
          videoId: row.video_id,
          packageVersion: row.package_version,
          title: row.title,
          sourceUrl: row.source_url,
          assets: listAssets(row.id),
        })),
    listSelectedPackages: () =>
      database
        .prepare(
          `
        SELECT clip_packages.*, package_jobs.video_id, package_jobs.package_version,
               videos.title, videos.source_url
        FROM clip_packages
        JOIN package_jobs ON package_jobs.id = clip_packages.package_job_id
        JOIN videos ON videos.video_id = package_jobs.video_id
        WHERE clip_packages.status = 'selected'
        ORDER BY clip_packages.id
      `,
        )
        .all()
        .map((row) => ({
          ...mapClipPackage(row),
          videoId: row.video_id,
          packageVersion: row.package_version,
          title: row.title,
          sourceUrl: row.source_url,
        })),
    listTreatmentRuns: (packageId) =>
      database
        .prepare(
          "SELECT * FROM treatment_runs WHERE clip_package_id = ? ORDER BY id",
        )
        .all(packageId)
        .map(mapTreatmentRun),
    markPackageFailed: (packageId, error) => {
      database
        .prepare(
          `
        UPDATE clip_packages
        SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?
      `,
        )
        .run(sanitizeErrorDiagnostic(error), now(), packageId);
    },
    markPackageJobFailed: (jobId, error) => {
      database
        .prepare(
          `
        UPDATE package_jobs
        SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?
      `,
        )
        .run(sanitizeErrorDiagnostic(error), now(), jobId);
    },
    markPackageReady: ({ packageId, assets }) => {
      const timestamp = now();
      database.exec("BEGIN IMMEDIATE");
      try {
        const upsertAsset = database.prepare(`
          INSERT INTO clip_assets (
            clip_package_id, role, relative_path, provenance, metadata_json,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(clip_package_id, role) DO UPDATE SET
            relative_path = excluded.relative_path,
            provenance = excluded.provenance,
            metadata_json = excluded.metadata_json,
            updated_at = excluded.updated_at
        `);
        for (const asset of assets) {
          upsertAsset.run(
            packageId,
            asset.role,
            asset.relativePath,
            asset.provenance ?? null,
            asset.metadataJson ?? null,
            timestamp,
            timestamp,
          );
        }
        database
          .prepare(
            `
          UPDATE clip_packages
          SET status = 'ready', last_error = NULL, updated_at = ? WHERE id = ?
        `,
          )
          .run(timestamp, packageId);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    markTreatmentRunFailed: (runId, error) => {
      database
        .prepare(
          `
        UPDATE treatment_runs
        SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?
      `,
        )
        .run(sanitizeErrorDiagnostic(error), now(), runId);
    },
    markTreatmentRunRendered: (runId, artifactRelativePath) => {
      database
        .prepare(
          `
        UPDATE treatment_runs
        SET status = 'rendered', artifact_relative_path = ?, last_error = NULL,
            updated_at = ? WHERE id = ?
      `,
        )
        .run(artifactRelativePath, now(), runId);
    },
    recordHeatmapSelection,
    syncPlaylistVideos,
  };
};
