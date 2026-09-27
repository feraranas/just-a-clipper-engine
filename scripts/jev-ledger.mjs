import { canonicalJson } from "./canonical-json.mjs";

export const ensureJevLedger = (database) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS jev_evaluations (
      id INTEGER PRIMARY KEY,
      analysis_id TEXT NOT NULL UNIQUE,
      recipe_sha256 TEXT NOT NULL,
      provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
      judgments_json TEXT NOT NULL CHECK(json_valid(judgments_json)),
      ranked_json TEXT NOT NULL CHECK(json_valid(ranked_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
};

export const persistJevEvaluation = (database, {
  analysisId,
  recipeSha256,
  provenance,
  judgments,
  ranked,
  timestamp = new Date().toISOString(),
}) => {
  if (!database || typeof database.exec !== "function") throw new Error("SQLite database is required");
  if (typeof analysisId !== "string" || !analysisId) throw new Error("analysisId is required");
  ensureJevLedger(database);
  database.prepare(`
    INSERT INTO jev_evaluations
      (analysis_id, recipe_sha256, provenance_json, judgments_json, ranked_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(analysis_id) DO UPDATE SET
      recipe_sha256=excluded.recipe_sha256,
      provenance_json=excluded.provenance_json,
      judgments_json=excluded.judgments_json,
      ranked_json=excluded.ranked_json,
      updated_at=excluded.updated_at
  `).run(analysisId, recipeSha256, canonicalJson(provenance ?? {}), canonicalJson(judgments), canonicalJson(ranked), timestamp, timestamp);
};

export const getJevEvaluation = (database, analysisId) => {
  ensureJevLedger(database);
  const row = database.prepare("SELECT * FROM jev_evaluations WHERE analysis_id = ?").get(analysisId);
  if (!row) return null;
  return {
    analysisId: row.analysis_id,
    recipeSha256: row.recipe_sha256,
    provenance: JSON.parse(row.provenance_json),
    judgments: JSON.parse(row.judgments_json),
    ranked: JSON.parse(row.ranked_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};
