import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  createCandidateReviewStore,
  prepareCandidateReview,
} from "./candidate-review.mjs";
import { resolveStorageConfig } from "./storage-config.mjs";
import { resolveSelectionConfig } from "./youtube-pipeline-config.mjs";
import {
  buildSelectionRecipe,
  buildTranscriptJsonSchema,
} from "./clip-selection-contract.mjs";
import {
  buildTranscriptPrompt,
  deriveClipSelections,
} from "./transcript-selector.mjs";
import { fetchYoutubeTranscript } from "./youtube-transcript-core.mjs";
import { createStructuredGenerationProvider } from "./structured-generation-provider.mjs";
import { createHttpJevClient } from "./jev-client.mjs";

export function reviewDatabase(environment = process.env) {
  return join(
    resolveStorageConfig(environment).dataRoot,
    "candidate-reviews.sqlite",
  );
}
export function candidateDependencies(environment = process.env) {
  const config = resolveSelectionConfig(environment);
  if (config.selectorId !== "transcript-llm")
    throw Error("Candidate review requires transcript-llm");
  const jevClient = createHttpJevClient({
    endpoint: environment.TYPESAFE_JEV_ENDPOINT,
    apiKey: environment.TYPESAFE_JEV_API_KEY,
  });
  const provider = createStructuredGenerationProvider(config, {
    environment,
    projectRoot: process.cwd(),
  });
  return {
    fetchTranscript: fetchYoutubeTranscript,
    jevClient,
    async draft(transcript) {
      const prompt = buildTranscriptPrompt(transcript);
      const generated = await provider.generateStructured({
        instructions: prompt.instructions,
        input: prompt.input,
        jsonSchema: buildTranscriptJsonSchema(config.desiredClipCount),
      });
      return {
        packages: deriveClipSelections(
          generated.parsed,
          transcript,
          buildSelectionRecipe(config).recipe,
        ),
        provenance: generated.provenance,
      };
    },
  };
}
export async function runCandidateCommand(args, environment = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      url: { type: "string" },
      review: { type: "string" },
      select: { type: "string" },
      hash: { type: "string" },
      db: { type: "string" },
      "review-id": { type: "string" },
      "retry-review": { type: "string" },
    },
  });
  if (values.url && (values.review || values.select || values.hash))
    throw Error("Choose preparation or review, not both");
  const store = createCandidateReviewStore(
    values.db ?? reviewDatabase(environment),
  );
  try {
    if (values["retry-review"]) {
      if (
        !values["review-id"] ||
        values.url ||
        values.review ||
        values.select ||
        values.hash
      )
        throw Error(
          "Retry requires a new review ID and the original review ID",
        );
      const prior = store.get(values["retry-review"]);
      if (!prior?.source?.videoId) throw Error("Review not found");
      return await prepareCandidateReview({
        store,
        url: `https://www.youtube.com/watch?v=${prior.source.videoId}`,
        reviewId: values["review-id"],
        retryFrom: values["retry-review"],
        ...candidateDependencies(environment),
      });
    }
    if (values.url)
      return await prepareCandidateReview({
        store,
        url: values.url,
        reviewId: values["review-id"],
        ...candidateDependencies(environment),
      });
    if (!values.review) throw Error("Supply --url or --review");
    if (values.select) {
      if (!values.hash) throw Error("Selection requires --hash");
      return store.select(values.review, values.hash, values.select);
    }
    const record = store.get(values.review);
    if (!record) throw Error("Review not found");
    return record;
  } finally {
    store.close();
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCandidateCommand(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error(
        "Candidate review failed. Check provider configuration and saved progress; no video was rendered.",
      );
      process.exitCode = 1;
    });
}
