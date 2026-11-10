import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  candidateDependencies,
  reviewDatabase,
} from "../../scripts/candidate-review-run.mjs";
import {
  createCandidateReviewStore,
  publicCandidateReview,
  retryCandidateTranscript,
} from "../../scripts/candidate-review.mjs";
import { parseYouTubeVideoUrl } from "../../scripts/youtube-url-core.mjs";

export function createCandidateReviewRunner({
  projectRoot,
  environment = process.env,
  launch = spawn,
}) {
  const access = (operation) => {
    const store = createCandidateReviewStore(reviewDatabase(environment));
    try {
      return operation(store);
    } finally {
      store.close();
    }
  };
  const start = (requestId, args) => {
    const child = launch(
      process.execPath,
      [join(projectRoot, "scripts/candidate-review-run.mjs"), ...args],
      { cwd: projectRoot, env: environment, stdio: "ignore" },
    );
    const finish = () =>
      access((s) => {
        const current = s.get(requestId);
        if (current?.state === "preparing")
          s.save({
            ...current,
            state: current.step === "queued" ? "failed" : "unknown",
            error:
              "Processing ended before a complete review was saved. Inspect before retrying.",
          });
      });
    child.once("error", finish);
    child.once("exit", finish);
  };
  return {
    async prepare({ url, requestId }) {
      const source = parseYouTubeVideoUrl(url);
      const existing = access((s) => s.get(requestId));
      if (existing) {
        if (existing.source.videoId !== source.videoId)
          throw Error("Request ID already belongs to another source");
        return publicCandidateReview(existing);
      }
      candidateDependencies(environment);
      const record = {
        reviewId: requestId,
        source,
        state: "preparing",
        step: "queued",
        selection: null,
        createdAt: new Date().toISOString(),
      };
      const reserved = access((s) => s.reserve(record));
      if (!reserved.created) {
        if (reserved.record.source.videoId !== source.videoId)
          throw Error("Request ID belongs to another source");
        return publicCandidateReview(reserved.record);
      }
      start(requestId, ["--url", url, "--review-id", requestId]);
      return publicCandidateReview(record);
    },
    async retry({ reviewId, requestId }) {
      const prior = access((s) => s.get(reviewId));
      retryCandidateTranscript(prior, prior?.source?.videoId);
      candidateDependencies(environment);
      const record = {
        reviewId: requestId,
        source: prior.source,
        state: "preparing",
        step: "queued",
        selection: null,
        createdAt: new Date().toISOString(),
        retryOf: reviewId,
      };
      const reservation = access((s) => s.reserve(record));
      if (!reservation.created) {
        if (reservation.record.retryOf !== reviewId)
          throw Error("Request ID belongs to another attempt");
        return publicCandidateReview(reservation.record);
      }
      start(requestId, ["--retry-review", reviewId, "--review-id", requestId]);
      return publicCandidateReview(record);
    },
    async get({ reviewId }) {
      const record = access((s) => s.get(reviewId));
      if (!record) throw Error("Review not found");
      return publicCandidateReview(record);
    },
    async select({ reviewId, reviewHash, candidateId }) {
      return publicCandidateReview(
        access((s) => s.select(reviewId, reviewHash, candidateId)),
      );
    },
  };
}
