import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCandidateReviewStore,
  prepareCandidateReview,
  publicCandidateReview,
} from "./candidate-review.mjs";
import { sha256Canonical } from "./canonical-json.mjs";

test("explicit timeout retry reuses verified transcript and preserves the original", async () => {
  const store = createCandidateReviewStore(
    join(mkdtempSync(join(tmpdir(), "candidate-retry-")), "reviews.sqlite"),
  );
  const transcript = {
    source: "youtube_auto",
    language: "en",
    cues: [{ id: "c000001", startMs: 0, endMs: 40000, text: "Evidence" }],
  };
  const original = {
    reviewId: "original",
    source: { videoId: "_U-O5lYhJ7Q" },
    state: "unknown",
    step: "drafting",
    diagnosticCode: "oauth_responses_timeout",
    transcript,
    sourceRevision: sha256Canonical(transcript),
  };
  store.save(original);
  assert.equal(
    publicCandidateReview(original).diagnosticCode,
    "oauth_responses_timeout",
  );
  assert.equal(
    publicCandidateReview({ ...original, diagnosticCode: "private-token" })
      .diagnosticCode,
    undefined,
  );
  let fetches = 0,
    drafts = 0;
  const args = {
    store,
    url: "https://youtu.be/_U-O5lYhJ7Q",
    reviewId: "retry",
    retryFrom: "original",
    fetchTranscript: async () => {
      fetches++;
      throw Error("must not fetch");
    },
    draft: async (t) => {
      drafts++;
      assert.deepEqual(t, transcript);
      throw Error("test failure");
    },
    jevClient: {},
  };
  await assert.rejects(
    prepareCandidateReview(args),
    /Candidate preparation failed/,
  );
  assert.equal(fetches, 0);
  assert.equal(drafts, 1);
  assert.deepEqual(store.get("original"), original);
  assert.equal(store.get("retry").retryOf, "original");
  await assert.rejects(prepareCandidateReview(args), /already started/);
  await assert.rejects(
    prepareCandidateReview({
      ...args,
      reviewId: "wrong",
      url: "https://youtu.be/j6UOJJqVVAs",
    }),
    /not eligible/,
  );
  assert.equal(drafts, 1);
  store.close();
});

test("review survives reopen, keeps questions and evidence, and requires explicit valid selection", async () => {
  const filename = join(
    mkdtempSync(join(tmpdir(), "candidate-review-")),
    "reviews.sqlite",
  );
  let store = createCandidateReviewStore(filename);
  const transcript = {
    source: "youtube_creator",
    language: "en",
    cues: [
      {
        id: "c000001",
        startMs: 0,
        endMs: 40000,
        text: "Cache hits avoid a database request.",
      },
    ],
  };
  const record = await prepareCandidateReview({
    store,
    url: "https://www.youtube.com/watch?v=_U-O5lYhJ7Q",
    fetchTranscript: async () => transcript,
    draft: async () => ({
      packages: [
        {
          startMs: 0,
          endMs: 40000,
          title: "Caching",
          summary: "Why cached reads are fast",
        },
      ],
      provenance: { providerId: "fixture" },
    }),
    jevClient: {
      async judgeCandidates({ questions, transcript: evidence }) {
        assert.equal(evidence.cues.length, 1);
        assert.ok(
          Object.keys(questions).some((k) =>
            k.includes("practical_implication"),
          ),
        );
        return Object.fromEntries(
          Object.entries(questions).map(([id, q]) => [
            id,
            q.type === "score"
              ? { score: 4, confidence: 0.9 }
              : {
                  noul: id.endsWith("containsSponsorOrCta") ? 0 : 1,
                  confidence: 0.9,
                },
          ]),
        );
      },
    },
  });
  assert.equal(record.state, "awaiting_selection");
  assert.equal(record.selection, null);
  assert.equal(
    record.review.candidates[0].evidence[0].text,
    transcript.cues[0].text,
  );
  store.close();
  store = createCandidateReviewStore(filename);
  assert.equal(store.get(record.reviewId).reviewHash, record.reviewHash);
  assert.throws(
    () => store.select(record.reviewId, "stale", "candidate-1"),
    /stale/i,
  );
  assert.throws(
    () => store.select(record.reviewId, record.reviewHash, "missing"),
    /candidate/i,
  );
  const selected = store.select(
    record.reviewId,
    record.reviewHash,
    "candidate-1",
  );
  assert.equal(selected.selection, "candidate-1");
  assert.equal(
    store.select(record.reviewId, record.reviewHash, "candidate-1").selection,
    "candidate-1",
  );
  store.close();
});

test("failed provider outcome is saved and never reported as completed review", async () => {
  const store = createCandidateReviewStore(
    join(mkdtempSync(join(tmpdir(), "candidate-fail-")), "reviews.sqlite"),
  );
  await assert.rejects(
    prepareCandidateReview({
      store,
      url: "https://www.youtube.com/watch?v=_U-O5lYhJ7Q",
      fetchTranscript: async () => ({ cues: [] }),
      draft: async () => {
        throw Error("private provider detail");
      },
      jevClient: { judgeCandidates() {} },
    }),
    /Candidate preparation failed/,
  );
  assert.equal(store.list()[0].state, "unknown");
  assert.ok(!JSON.stringify(store.list()).includes("private provider detail"));
  store.close();
});

test("the same review ID cannot start twice, and tampered reviews fail reads", () => {
  const store = createCandidateReviewStore(
    join(mkdtempSync(join(tmpdir(), "candidate-lock-")), "reviews.sqlite"),
  );
  const queued = {
    reviewId: "id",
    source: { videoId: "video" },
    step: "queued",
    state: "preparing",
  };
  assert.equal(store.reserve(queued).created, true);
  assert.equal(store.reserve(queued).created, false);
  store.claim("id");
  assert.throws(() => store.claim("id"), /already started/);
  store.save({
    reviewId: "tampered",
    review: { candidates: [] },
    reviewHash: "wrong",
  });
  assert.throws(() => store.get("tampered"), /fingerprint/);
  store.close();
});

test("actual noul responses need no confidence field and framework answers remain inspectable", async () => {
  const store = createCandidateReviewStore(
    join(mkdtempSync(join(tmpdir(), "candidate-noul-")), "reviews.sqlite"),
  );
  const result = await prepareCandidateReview({
    store,
    url: "https://youtu.be/_U-O5lYhJ7Q",
    fetchTranscript: async () => ({
      source: "youtube_auto",
      language: "en",
      cues: [{ id: "c000001", startMs: 0, endMs: 40000, text: "Evidence" }],
    }),
    draft: async () => ({
      packages: [
        { title: "Idea", summary: "Summary", startMs: 0, endMs: 40000 },
      ],
      provenance: { providerId: "fixture" },
    }),
    jevClient: {
      judgeCandidates: async ({ questions }) =>
        Object.fromEntries(
          Object.entries(questions).map(([id, q]) => [
            id,
            q.type === "score"
              ? { score: 3, confidence: 0.4 }
              : { noul: id.endsWith("containsSponsorOrCta") ? 0 : 1 },
          ]),
        ),
    },
  });
  assert.equal(result.state, "awaiting_selection");
  assert.equal(Object.keys(result.review.rawAnswers).length, 14);
  assert.equal(result.review.candidates[0].reviewRequired, true);
  store.close();
});

test("reading progress after processing stopped reports unknown without reissuing requests", () => {
  const store = createCandidateReviewStore(
    join(mkdtempSync(join(tmpdir(), "candidate-crash-")), "reviews.sqlite"),
  );
  store.save({
    reviewId: "dead",
    state: "preparing",
    step: "judging",
    ownerPid: 2147483647,
  });
  assert.equal(store.get("dead").state, "unknown");
  store.close();
});
