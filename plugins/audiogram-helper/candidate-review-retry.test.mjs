import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Canonical } from "../../scripts/canonical-json.mjs";
import { createCandidateReviewStore } from "../../scripts/candidate-review.mjs";
import { reviewDatabase } from "../../scripts/candidate-review-run.mjs";
import { createCandidateReviewRunner } from "./candidate-review-runner.mjs";

test("explicit retry reserves one linked attempt and starts one worker", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "candidate-retry-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const environment = {
    AUDIOGRAM_DATA_ROOT: root,
    AUDIOGRAM_LLM_PROVIDER: "chatgpt-oauth",
    TYPESAFE_JEV_ENDPOINT: "https://example.com",
    TYPESAFE_JEV_API_KEY: "fixture",
  };
  const transcript = {
    source: "youtube_auto",
    language: "en",
    cues: [{ id: "c000001", startMs: 0, endMs: 40000, text: "Evidence" }],
  };
  const store = createCandidateReviewStore(reviewDatabase(environment));
  store.save({
    reviewId: "original",
    source: { videoId: "_U-O5lYhJ7Q" },
    state: "unknown",
    step: "drafting",
    diagnosticCode: "oauth_responses_timeout",
    transcript,
    sourceRevision: sha256Canonical(transcript),
  });
  store.close();
  const calls = [];
  const runner = createCandidateReviewRunner({
    projectRoot: root,
    environment,
    launch: (...args) => {
      calls.push(args);
      return new EventEmitter();
    },
  });
  const first = await runner.retry({ reviewId: "original", requestId: "next" });
  const second = await runner.retry({
    reviewId: "original",
    requestId: "next",
  });
  assert.equal(first.retryOf, "original");
  assert.equal(second.reviewId, "next");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].slice(-4), [
    "--retry-review",
    "original",
    "--review-id",
    "next",
  ]);
  await assert.rejects(
    runner.retry({ reviewId: "missing", requestId: "other" }),
    /eligible/,
  );
});
