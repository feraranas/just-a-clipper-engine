import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getJevEvaluation, persistJevEvaluation } from "./jev-ledger.mjs";

test("persists and reads Jev judgments and ranking idempotently", () => {
  const database = new DatabaseSync(":memory:");
  const payload = {
    analysisId: "analysis-1",
    recipeSha256: "recipe-hash",
    provenance: { providerId: "typesafe", model: "jev" },
    judgments: { candidate: { confidence: .9 } },
    ranked: [{ candidateId: "candidate", score: .8 }],
  };
  persistJevEvaluation(database, payload);
  persistJevEvaluation(database, payload);
  const stored = getJevEvaluation(database, "analysis-1");
  assert.deepEqual(stored.analysisId, payload.analysisId);
  assert.deepEqual(stored.judgments, payload.judgments);
  assert.deepEqual(stored.ranked, payload.ranked);
  assert.equal(typeof stored.createdAt, "string");
  assert.equal(typeof stored.updatedAt, "string");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM jev_evaluations").get().count, 1);
  database.close();
});
