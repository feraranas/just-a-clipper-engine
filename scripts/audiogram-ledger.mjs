import { DatabaseSync } from "node:sqlite";

import { canonicalJson, sha256Canonical } from "./canonical-json.mjs";
import {
  buildSelectionRecipe,
  HEATMAP_SCHEMA_SHA256,
} from "./clip-selection-contract.mjs";
import { sanitizeErrorDiagnostic } from "./error-diagnostics.mjs";
import { computeTranscriptIdentity } from "./youtube-transcript-core.mjs";

export const AUDIOGRAM_SCHEMA_VERSION = 2;

const DEFAULT_SELECTION_RECIPE = buildSelectionRecipe({
  selectorId: "youtube-heatmap",
});
const LEGACY_UNKNOWN_RECIPE_OBJECT = {
  recipeVersion: 1,
  selector: { id: "youtube-heatmap-legacy", version: "0" },
  provider: null,
  prompt: null,
  outputSchema: { version: 1, sha256: HEATMAP_SCHEMA_SHA256 },
  parameters: { maxClips: "unknown", minimumSeparationMs: "unknown" },
};
const LEGACY_UNKNOWN_SELECTION_RECIPE = Object.freeze({
  recipe: Object.freeze(LEGACY_UNKNOWN_RECIPE_OBJECT),
  json: canonicalJson(LEGACY_UNKNOWN_RECIPE_OBJECT),
  sha256: sha256Canonical(LEGACY_UNKNOWN_RECIPE_OBJECT),
});

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
const REQUIRED_SCHEMA_VERSION_2_COLUMNS = {
  ...REQUIRED_SCHEMA_VERSION_1_COLUMNS,
  package_jobs: [
    ...REQUIRED_SCHEMA_VERSION_1_COLUMNS.package_jobs,
    "selection_recipe_json",
    "selection_recipe_sha256",
  ],
  transcripts: [
    "id",
    "video_id",
    "source",
    "language",
    "content_sha256",
    "cues_json",
    "cue_count",
    "canonical_utf8_bytes",
    "created_at",
    "updated_at",
  ],
  selection_runs: [
    "id",
    "package_job_id",
    "transcript_id",
    "selector_id",
    "selector_version",
    "provider_id",
    "model_id",
    "prompt_version",
    "prompt_sha256",
    "output_schema_version",
    "output_schema_sha256",
    "provider_response_id",
    "usage_json",
    "result_json",
    "created_at",
    "updated_at",
  ],
};

const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

const validateSelectionRecipe = (selectionRecipe) => {
  if (
    !isPlainObject(selectionRecipe) ||
    !isPlainObject(selectionRecipe.recipe) ||
    typeof selectionRecipe.json !== "string" ||
    typeof selectionRecipe.sha256 !== "string"
  )
    throw new Error("Invalid selection recipe envelope");
  const json = canonicalJson(selectionRecipe.recipe);
  const sha256 = sha256Canonical(selectionRecipe.recipe);
  if (selectionRecipe.json !== json || selectionRecipe.sha256 !== sha256)
    throw new Error("Selection recipe JSON/hash is not canonical");
  return selectionRecipe;
};

const parseStoredRecipe = (row) => {
  let recipe;
  try {
    recipe = JSON.parse(row.selection_recipe_json);
  } catch {
    throw new Error(`Package job ${row.id} has invalid selection recipe JSON`);
  }
  let json;
  let sha256;
  try {
    json = canonicalJson(recipe);
    sha256 = sha256Canonical(recipe);
  } catch {
    throw new Error(`Package job ${row.id} has invalid selection recipe JSON`);
  }
  if (
    row.selection_recipe_json !== json ||
    row.selection_recipe_sha256 !== sha256
  )
    throw new Error(
      `Package job ${row.id} selection recipe JSON/hash is not canonical`,
    );
  return { recipe, json, sha256 };
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
        selectionRecipeJson: row.selection_recipe_json,
        selectionRecipeSha256: row.selection_recipe_sha256,
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

const mapSelectionRun = (row) =>
  row
    ? {
        id: row.id,
        packageJobId: row.package_job_id,
        transcriptId: row.transcript_id,
        selectorId: row.selector_id,
        selectorVersion: row.selector_version,
        providerId: row.provider_id,
        modelId: row.model_id,
        promptVersion: row.prompt_version,
        promptSha256: row.prompt_sha256,
        outputSchemaVersion: row.output_schema_version,
        outputSchemaSha256: row.output_schema_sha256,
        providerResponseId: row.provider_response_id,
        usage: row.usage_json === null ? null : JSON.parse(row.usage_json),
        result: JSON.parse(row.result_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;

const mapTranscript = (row) => {
  if (!row) return null;
  let cues;
  try {
    cues = JSON.parse(row.cues_json);
  } catch {
    throw new Error(`Transcript ${row.id} has invalid cue JSON`);
  }
  const identity = computeTranscriptIdentity({
    source: row.source,
    language: row.language,
    cues,
  });
  if (
    row.cue_count !== cues.length ||
    row.content_sha256 !== identity.sha256 ||
    row.canonical_utf8_bytes !== identity.canonicalUtf8Bytes
  )
    throw new Error(`Transcript ${row.id} persisted identity does not match`);
  return {
    id: row.id,
    videoId: row.video_id,
    source: row.source,
    language: row.language,
    sha256: row.content_sha256,
    cues,
    cueCount: row.cue_count,
    canonicalUtf8Bytes: row.canonical_utf8_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

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

const createSchemaVersion1Tables = (database) => {
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
  createSchemaVersion1Tables(database);
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

const validateRequiredColumns = (database, version, requiredTables) => {
  for (const [table, requiredColumns] of Object.entries(requiredTables)) {
    if (!tableExists(database, table)) {
      throw new Error(
        `Invalid audiogram schema version ${version}: missing table ${table}`,
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
        `Invalid audiogram schema version ${version}: table ${table} missing columns ` +
          missingColumns.join(", "),
      );
    }
  }
};

const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;

const normalizedTableSql = (database, table) =>
  database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table)
    ?.sql?.replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const uniqueColumnSets = (database, table) =>
  database
    .prepare(`PRAGMA index_list(${quoteIdentifier(table)})`)
    .all()
    .filter((index) => index.unique === 1 && index.origin !== "pk")
    .map((index) =>
      database
        .prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`)
        .all()
        .sort((left, right) => left.seqno - right.seqno)
        .map(({ name }) => name)
        .join(","),
    )
    .sort();

const foreignKeyContracts = (database, table) =>
  database
    .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)
    .all()
    .map((foreignKey) =>
      [
        foreignKey.from,
        foreignKey.table,
        foreignKey.to,
        foreignKey.on_update,
        foreignKey.on_delete,
      ].join("|"),
    )
    .sort();

const VERSION_1_STRUCTURE = {
  videos: { unique: [], foreignKeys: [], checks: [] },
  package_jobs: {
    unique: ["video_id,package_version"],
    foreignKeys: ["video_id|videos|video_id|NO ACTION|CASCADE"],
    checks: [
      "check (status in ('discovered', 'heatmap_ready', 'no_heatmap', 'failed'))",
    ],
  },
  clip_packages: {
    unique: ["package_job_id,rank"],
    foreignKeys: ["package_job_id|package_jobs|id|NO ACTION|CASCADE"],
    checks: [
      "check (rank >= 1)",
      "check (start_seconds >= 0)",
      "check (end_seconds > start_seconds)",
      "check (status in ('selected', 'ready', 'failed'))",
    ],
  },
  clip_assets: {
    unique: ["clip_package_id,role"],
    foreignKeys: ["clip_package_id|clip_packages|id|NO ACTION|CASCADE"],
    checks: [],
  },
  treatment_runs: {
    unique: ["clip_package_id,treatment_id,treatment_version"],
    foreignKeys: ["clip_package_id|clip_packages|id|NO ACTION|CASCADE"],
    checks: ["check (status in ('pending', 'rendered', 'failed'))"],
  },
};

const validateSchemaVersion1 = (database) => {
  validateRequiredColumns(database, 1, REQUIRED_SCHEMA_VERSION_1_COLUMNS);
  const tableList = new Map(
    database
      .prepare("PRAGMA table_list")
      .all()
      .filter(({ schema }) => schema === "main")
      .map((row) => [row.name, row]),
  );
  for (const [table, expected] of Object.entries(VERSION_1_STRUCTURE)) {
    const sql = normalizedTableSql(database, table);
    if (!sql || tableList.get(table)?.strict !== 1 || !/\) strict$/.test(sql))
      throw new Error(
        `Invalid audiogram schema version 1: table ${table} missing STRICT structural invariant`,
      );
    for (const check of expected.checks)
      if (!sql.includes(check))
        throw new Error(
          `Invalid audiogram schema version 1: table ${table} missing CHECK structural invariant`,
        );
    if (
      JSON.stringify(uniqueColumnSets(database, table)) !==
      JSON.stringify(expected.unique)
    )
      throw new Error(
        `Invalid audiogram schema version 1: table ${table} has altered UNIQUE structural invariants`,
      );
    if (
      JSON.stringify(foreignKeyContracts(database, table)) !==
      JSON.stringify(expected.foreignKeys)
    )
      throw new Error(
        `Invalid audiogram schema version 1: table ${table} has altered foreign-key structural invariants`,
      );
  }
};

const validateSchemaVersion2 = (database, { validateRecipes = false } = {}) => {
  validateRequiredColumns(database, 2, REQUIRED_SCHEMA_VERSION_2_COLUMNS);
  if (validateRecipes)
    for (const row of database.prepare("SELECT * FROM package_jobs").all())
      parseStoredRecipe(row);
  const foreignKeyFailures = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyFailures.length > 0)
    throw new Error(
      "Invalid audiogram schema version 2: foreign-key check failed",
    );
};

const validateLegacyHeatmapRecipeMap = (mapping, packageVersions) => {
  if (!isPlainObject(mapping))
    throw new Error("Invalid legacy heatmap recipe mapping");
  for (const [version, parameters] of Object.entries(mapping)) {
    if (!packageVersions.has(version))
      throw new Error(
        `Legacy heatmap recipe mapping references absent package version ${version}`,
      );
    if (
      !isPlainObject(parameters) ||
      Object.keys(parameters).sort().join(",") !==
        "maxClips,minimumSeparationMs" ||
      !Number.isSafeInteger(parameters.maxClips) ||
      parameters.maxClips < 1 ||
      !Number.isSafeInteger(parameters.minimumSeparationMs) ||
      parameters.minimumSeparationMs < 0
    )
      throw new Error("Invalid legacy heatmap recipe mapping");
  }
};

const normalizeHeatmap = (value, label = "heatmap") => {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label} JSON`);
  return value.map((item, index) => {
    if (
      !isPlainObject(item) ||
      !Number.isFinite(item.startTime) ||
      !Number.isFinite(item.endTime) ||
      !Number.isFinite(item.value)
    )
      throw new Error(`Invalid ${label} item at index ${index}`);
    return {
      startTime: item.startTime,
      endTime: item.endTime,
      value: item.value,
    };
  });
};

const normalizePackages = (packages, { milliseconds = false } = {}) => {
  if (!Array.isArray(packages)) throw new Error("Invalid selected packages");
  return packages.map((item, index) => {
    const startSeconds = milliseconds
      ? item?.startMs / 1_000
      : item?.startSeconds;
    const endSeconds = milliseconds ? item?.endMs / 1_000 : item?.endSeconds;
    if (
      !isPlainObject(item) ||
      !Number.isSafeInteger(item.rank) ||
      item.rank < 1 ||
      !Number.isFinite(startSeconds) ||
      startSeconds < 0 ||
      !Number.isFinite(endSeconds) ||
      endSeconds <= startSeconds ||
      !Number.isFinite(item.score)
    )
      throw new Error(`Invalid selected package at index ${index}`);
    return { rank: item.rank, startSeconds, endSeconds, score: item.score };
  });
};

const createSchemaVersion2Tables = (database) => {
  database.exec(`
    CREATE TABLE package_jobs_v2 (
      id INTEGER PRIMARY KEY,
      video_id TEXT NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
      package_version TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'discovered'
        CHECK (status IN ('discovered', 'selection_ready', 'no_selection', 'failed')),
      heatmap_json TEXT,
      selection_recipe_json TEXT NOT NULL CHECK(json_valid(selection_recipe_json)),
      selection_recipe_sha256 TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (video_id, package_version)
    ) STRICT;

    CREATE TABLE transcripts (
      id INTEGER PRIMARY KEY,
      video_id TEXT NOT NULL REFERENCES videos(video_id) ON DELETE CASCADE,
      source TEXT NOT NULL CHECK(source IN ('youtube_creator','youtube_auto')),
      language TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      cues_json TEXT NOT NULL CHECK(json_valid(cues_json)),
      cue_count INTEGER NOT NULL CHECK(cue_count > 0),
      canonical_utf8_bytes INTEGER NOT NULL CHECK(canonical_utf8_bytes > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(video_id, source, language, content_sha256)
    ) STRICT;
  `);
};

const createSelectionRunsTable = (database) => {
  database.exec(`
    CREATE TABLE selection_runs (
      id INTEGER PRIMARY KEY,
      package_job_id INTEGER NOT NULL UNIQUE REFERENCES package_jobs(id) ON DELETE CASCADE,
      transcript_id INTEGER REFERENCES transcripts(id) ON DELETE RESTRICT,
      selector_id TEXT NOT NULL,
      selector_version TEXT NOT NULL,
      provider_id TEXT,
      model_id TEXT,
      prompt_version TEXT,
      prompt_sha256 TEXT,
      output_schema_version INTEGER NOT NULL,
      output_schema_sha256 TEXT NOT NULL,
      provider_response_id TEXT,
      usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),
      result_json TEXT NOT NULL CHECK(json_valid(result_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
};

const recipeForLegacyJob = ({
  row,
  hasClips,
  selectionRecipe,
  packageVersion,
  legacyHeatmapRecipeMap,
}) => {
  const terminal =
    row.status === "heatmap_ready" || row.status === "no_heatmap" || hasClips;
  if (!terminal)
    return row.package_version === packageVersion
      ? selectionRecipe
      : LEGACY_UNKNOWN_SELECTION_RECIPE;
  const mapped = legacyHeatmapRecipeMap[row.package_version];
  return mapped
    ? buildSelectionRecipe({ selectorId: "youtube-heatmap", ...mapped })
    : LEGACY_UNKNOWN_SELECTION_RECIPE;
};

const insertSelectionRun = (
  database,
  {
    jobId,
    transcriptId = null,
    selectionRecipe,
    provenance = {},
    result,
    createdAt,
    updatedAt,
  },
) => {
  const { recipe } = selectionRecipe;
  database
    .prepare(
      `
      INSERT INTO selection_runs (
        package_job_id, transcript_id, selector_id, selector_version,
        provider_id, model_id, prompt_version, prompt_sha256,
        output_schema_version, output_schema_sha256, provider_response_id,
        usage_json, result_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(package_job_id) DO UPDATE SET
        transcript_id = excluded.transcript_id,
        selector_id = excluded.selector_id,
        selector_version = excluded.selector_version,
        provider_id = excluded.provider_id,
        model_id = excluded.model_id,
        prompt_version = excluded.prompt_version,
        prompt_sha256 = excluded.prompt_sha256,
        output_schema_version = excluded.output_schema_version,
        output_schema_sha256 = excluded.output_schema_sha256,
        provider_response_id = excluded.provider_response_id,
        usage_json = excluded.usage_json,
        result_json = excluded.result_json,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      jobId,
      transcriptId,
      recipe.selector.id,
      recipe.selector.version,
      recipe.provider?.id ?? null,
      recipe.provider?.model ?? null,
      recipe.prompt?.version ?? null,
      recipe.prompt?.sha256 ?? null,
      recipe.outputSchema.version,
      recipe.outputSchema.sha256,
      provenance.responseId ?? null,
      provenance.usage === undefined ? null : canonicalJson(provenance.usage),
      canonicalJson(result),
      createdAt,
      updatedAt,
    );
};

const migrateToSchemaVersion2 = (
  database,
  { selectionRecipe, packageVersion, legacyHeatmapRecipeMap },
) => {
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec("BEGIN IMMEDIATE");
  try {
    if (readSchemaVersion(database) === 0) {
      const classification = classifyUnversionedSchema(database);
      if (classification === "fresh") {
        createSchemaVersion1Tables(database);
      } else if (classification === "legacy") {
        migrateLegacyTables(database);
      } else {
        ensureClipAssetColumns(database);
      }
    }
    validateSchemaVersion1(database);
    const jobs = database
      .prepare("SELECT * FROM package_jobs ORDER BY id")
      .all();
    const packageVersions = new Set(jobs.map((row) => row.package_version));
    validateLegacyHeatmapRecipeMap(legacyHeatmapRecipeMap, packageVersions);
    const clipCounts = new Map(
      database
        .prepare(
          "SELECT package_job_id, COUNT(*) AS count FROM clip_packages GROUP BY package_job_id",
        )
        .all()
        .map((row) => [row.package_job_id, row.count]),
    );

    createSchemaVersion2Tables(database);
    const insertJob = database.prepare(`
      INSERT INTO package_jobs_v2 (
        id, video_id, package_version, status, heatmap_json,
        selection_recipe_json, selection_recipe_sha256, last_error,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const completedRuns = [];
    for (const row of jobs) {
      const hasClips = (clipCounts.get(row.id) ?? 0) > 0;
      const recipe = recipeForLegacyJob({
        row,
        hasClips,
        selectionRecipe,
        packageVersion,
        legacyHeatmapRecipeMap,
      });
      const status =
        row.status === "heatmap_ready"
          ? "selection_ready"
          : row.status === "no_heatmap"
            ? "no_selection"
            : row.status;
      insertJob.run(
        row.id,
        row.video_id,
        row.package_version,
        status,
        row.heatmap_json,
        recipe.json,
        recipe.sha256,
        row.last_error,
        row.created_at,
        row.updated_at,
      );
      if (
        row.status === "heatmap_ready" ||
        row.status === "no_heatmap" ||
        hasClips
      ) {
        let parsedHeatmap = [];
        if (row.heatmap_json !== null) {
          try {
            parsedHeatmap = JSON.parse(row.heatmap_json);
          } catch {
            throw new Error(`Invalid heatmap JSON for package job ${row.id}`);
          }
        }
        const clips = database
          .prepare(
            `SELECT rank, start_seconds, end_seconds, score
             FROM clip_packages WHERE package_job_id = ? ORDER BY rank`,
          )
          .all(row.id)
          .map((clip) => ({
            rank: clip.rank,
            startSeconds: clip.start_seconds,
            endSeconds: clip.end_seconds,
            score: clip.score,
          }));
        completedRuns.push({
          row,
          recipe,
          result: {
            schemaVersion: 1,
            heatmap: normalizeHeatmap(parsedHeatmap, "heatmap migration"),
            clips: normalizePackages(clips),
          },
        });
      }
    }
    database.exec(`
      DROP TABLE package_jobs;
      ALTER TABLE package_jobs_v2 RENAME TO package_jobs;
      CREATE INDEX package_jobs_status_idx ON package_jobs(status);
    `);
    createSelectionRunsTable(database);
    for (const { row, recipe, result } of completedRuns)
      insertSelectionRun(database, {
        jobId: row.id,
        selectionRecipe: recipe,
        result,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });

    validateSchemaVersion2(database, { validateRecipes: true });
    database.exec(`PRAGMA user_version = ${AUDIOGRAM_SCHEMA_VERSION}`);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
  database.exec("PRAGMA foreign_keys = ON");
};

export const openAudiogramLedger = (
  path,
  {
    now = () => new Date().toISOString(),
    selectionRecipe = DEFAULT_SELECTION_RECIPE,
    packageVersion = "v1",
    legacyHeatmapRecipeMap = {},
  } = {},
) => {
  const currentSelectionRecipe = validateSelectionRecipe(selectionRecipe);
  if (typeof packageVersion !== "string" || !packageVersion)
    throw new Error("packageVersion must be a nonempty string");
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

    if (schemaVersion === 0 || schemaVersion === 1) {
      if (schemaVersion === 1) validateSchemaVersion1(database);
      migrateToSchemaVersion2(database, {
        selectionRecipe: currentSelectionRecipe,
        packageVersion,
        legacyHeatmapRecipeMap,
      });
    } else {
      database.exec("PRAGMA foreign_keys = ON");
      validateSchemaVersion2(database);
    }
    if (!database.prepare("PRAGMA foreign_keys").get().foreign_keys) {
      database.exec("PRAGMA foreign_keys = ON");
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

  const jobHasCompletedSelection = (row) =>
    row.status === "selection_ready" ||
    row.status === "no_selection" ||
    Boolean(
      database
        .prepare("SELECT 1 FROM selection_runs WHERE package_job_id = ?")
        .get(row.id),
    ) ||
    Boolean(
      database
        .prepare("SELECT 1 FROM clip_packages WHERE package_job_id = ? LIMIT 1")
        .get(row.id),
    );

  const ensureJobRecipe = (
    row,
    requestedRecipe,
    { adoptUnprocessed = false } = {},
  ) => {
    const stored = parseStoredRecipe(row);
    if (stored.sha256 === requestedRecipe.sha256) return;
    const isLegacyUnknown =
      stored.recipe?.selector?.id === "youtube-heatmap-legacy" &&
      stored.recipe?.selector?.version === "0";
    if (adoptUnprocessed && isLegacyUnknown && !jobHasCompletedSelection(row)) {
      database
        .prepare(
          `UPDATE package_jobs
           SET selection_recipe_json = ?, selection_recipe_sha256 = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(requestedRecipe.json, requestedRecipe.sha256, now(), row.id);
      return;
    }
    if (isLegacyUnknown)
      throw new Error(
        `Package version ${row.package_version} uses a historical selection whose prior settings are unknowable; set a new AUDIOGRAM_PACKAGE_VERSION`,
      );
    throw new Error(
      `Selection recipe changed for package version ${row.package_version}; use a new package version`,
    );
  };

  const syncPlaylistVideos = ({
    playlistId,
    packageVersion,
    videos,
    selectionRecipe = currentSelectionRecipe,
  }) => {
    const requestedRecipe = validateSelectionRecipe(selectionRecipe);
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
          video_id, package_version, status, selection_recipe_json,
          selection_recipe_sha256, created_at, updated_at
        ) VALUES (?, ?, 'discovered', ?, ?, ?, ?)
        ON CONFLICT(video_id, package_version) DO NOTHING
      `);
      for (const video of videos) {
        const existingJob = getPackageJobStatement.get(
          video.videoId,
          packageVersion,
        );
        if (existingJob)
          ensureJobRecipe(existingJob, requestedRecipe, {
            adoptUnprocessed: true,
          });
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
        createJob.run(
          video.videoId,
          packageVersion,
          requestedRecipe.json,
          requestedRecipe.sha256,
          timestamp,
          timestamp,
        );
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return { discovered, existing };
  };

  const insertPackages = (jobId, packages, timestamp) => {
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
    for (const clipPackage of packages)
      insertPackage.run(
        jobId,
        clipPackage.rank,
        clipPackage.startSeconds,
        clipPackage.endSeconds,
        clipPackage.score,
        timestamp,
        timestamp,
      );
  };

  const assertSelectionCanBeRecorded = (jobId) => {
    const existingRun = database
      .prepare("SELECT 1 FROM selection_runs WHERE package_job_id = ?")
      .get(jobId);
    const existingPackage = database
      .prepare("SELECT 1 FROM clip_packages WHERE package_job_id = ? LIMIT 1")
      .get(jobId);
    if (existingRun || existingPackage)
      throw new Error(
        `Selection for package job ${jobId} is already completed and immutable`,
      );
  };

  const validateUsage = (usage) => {
    if (usage === undefined) return;
    if (!isPlainObject(usage)) throw new Error("Invalid provider usage");
    const scalar = new Set(["input_tokens", "output_tokens", "total_tokens"]);
    const nested = new Map([
      ["input_tokens_details", new Set(["cached_tokens"])],
      ["output_tokens_details", new Set(["reasoning_tokens"])],
    ]);
    for (const [key, value] of Object.entries(usage)) {
      if (scalar.has(key)) {
        if (!Number.isSafeInteger(value) || value < 0)
          throw new Error("Invalid provider usage");
      } else if (nested.has(key)) {
        if (!isPlainObject(value)) throw new Error("Invalid provider usage");
        for (const [nestedKey, nestedValue] of Object.entries(value))
          if (
            !nested.get(key).has(nestedKey) ||
            !Number.isSafeInteger(nestedValue) ||
            nestedValue < 0
          )
            throw new Error("Invalid provider usage");
      } else {
        throw new Error("Invalid provider usage");
      }
    }
  };

  const recordHeatmapSelection = ({
    jobId,
    heatmap,
    packages,
    selectionRecipe = currentSelectionRecipe,
  }) => {
    const requestedRecipe = validateSelectionRecipe(selectionRecipe);
    if (
      requestedRecipe.recipe.selector.id !== "youtube-heatmap" ||
      requestedRecipe.recipe.outputSchema.sha256 !== HEATMAP_SCHEMA_SHA256
    )
      throw new Error("Heatmap selection requires the current heatmap recipe");
    const normalizedHeatmap = normalizeHeatmap(heatmap);
    const normalizedPackages = normalizePackages(packages);
    const timestamp = now();
    const status =
      normalizedPackages.length > 0 ? "selection_ready" : "no_selection";
    database.exec("BEGIN IMMEDIATE");
    try {
      const job = database
        .prepare("SELECT * FROM package_jobs WHERE id = ?")
        .get(jobId);
      if (!job) throw new Error(`Unknown package job ${jobId}`);
      ensureJobRecipe(job, requestedRecipe);
      assertSelectionCanBeRecorded(jobId);
      database
        .prepare(
          `
        UPDATE package_jobs
        SET status = ?, heatmap_json = ?, last_error = NULL, updated_at = ?
        WHERE id = ?
      `,
        )
        .run(status, canonicalJson(normalizedHeatmap), timestamp, jobId);
      insertPackages(jobId, normalizedPackages, timestamp);
      insertSelectionRun(database, {
        jobId,
        selectionRecipe: requestedRecipe,
        result: {
          schemaVersion: 1,
          heatmap: normalizedHeatmap,
          clips: normalizedPackages,
        },
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };

  const recordTranscriptSelection = ({
    jobId,
    transcript,
    result,
    packages,
    provenance,
    selectionRecipe = currentSelectionRecipe,
  }) => {
    const requestedRecipe = validateSelectionRecipe(selectionRecipe);
    const { recipe } = requestedRecipe;
    if (recipe.selector.id !== "transcript-llm" || !recipe.provider)
      throw new Error("Transcript selection requires a transcript recipe");
    if (
      !isPlainObject(transcript) ||
      !["youtube_creator", "youtube_auto"].includes(transcript.source) ||
      typeof transcript.language !== "string" ||
      !transcript.language ||
      !Array.isArray(transcript.cues) ||
      transcript.cues.length === 0
    )
      throw new Error("Invalid transcript envelope");
    const identity = computeTranscriptIdentity(transcript);
    if (
      transcript.sha256 !== identity.sha256 ||
      transcript.canonicalUtf8Bytes !== identity.canonicalUtf8Bytes
    )
      throw new Error(
        "Transcript identity or sha256 does not match its content",
      );
    if (!isPlainObject(result)) throw new Error("Invalid transcript result");
    const normalizedPackages = normalizePackages(packages, {
      milliseconds: true,
    });
    if (
      !isPlainObject(provenance) ||
      provenance.providerId !== recipe.provider.id ||
      provenance.model !== recipe.provider.model ||
      provenance.recipeSha256 !== requestedRecipe.sha256 ||
      (provenance.responseId !== undefined &&
        (typeof provenance.responseId !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(provenance.responseId)))
    )
      throw new Error("Transcript provider provenance does not match recipe");
    validateUsage(provenance.usage);
    const timestamp = now();
    database.exec("BEGIN IMMEDIATE");
    try {
      const job = database
        .prepare("SELECT * FROM package_jobs WHERE id = ?")
        .get(jobId);
      if (!job) throw new Error(`Unknown package job ${jobId}`);
      ensureJobRecipe(job, requestedRecipe);
      assertSelectionCanBeRecorded(jobId);
      const upsertedTranscript = database
        .prepare(
          `
          INSERT INTO transcripts (
            video_id, source, language, content_sha256, cues_json, cue_count,
            canonical_utf8_bytes, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(video_id, source, language, content_sha256) DO UPDATE SET
            cues_json = excluded.cues_json,
            cue_count = excluded.cue_count,
            canonical_utf8_bytes = excluded.canonical_utf8_bytes,
            updated_at = excluded.updated_at
          RETURNING id
        `,
        )
        .get(
          job.video_id,
          transcript.source,
          transcript.language,
          identity.sha256,
          canonicalJson(transcript.cues),
          transcript.cues.length,
          identity.canonicalUtf8Bytes,
          timestamp,
          timestamp,
        );
      insertPackages(jobId, normalizedPackages, timestamp);
      insertSelectionRun(database, {
        jobId,
        transcriptId: upsertedTranscript.id,
        selectionRecipe: requestedRecipe,
        provenance,
        result,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      database
        .prepare(
          `UPDATE package_jobs
           SET status = ?, heatmap_json = NULL, last_error = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          normalizedPackages.length > 0 ? "selection_ready" : "no_selection",
          timestamp,
          jobId,
        );
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
    getSelectionRun: (jobId) =>
      mapSelectionRun(
        database
          .prepare("SELECT * FROM selection_runs WHERE package_job_id = ?")
          .get(jobId),
      ),
    getTranscript: (transcriptId) =>
      mapTranscript(
        database
          .prepare("SELECT * FROM transcripts WHERE id = ?")
          .get(transcriptId),
      ),
    getTranscriptForPackage: (packageId) =>
      mapTranscript(
        database
          .prepare(
            `
            SELECT transcripts.*
            FROM clip_packages
            JOIN selection_runs
              ON selection_runs.package_job_id = clip_packages.package_job_id
            JOIN transcripts ON transcripts.id = selection_runs.transcript_id
            WHERE clip_packages.id = ?
          `,
          )
          .get(packageId),
      ),
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
    recordTranscriptSelection,
    syncPlaylistVideos,
  };
};
