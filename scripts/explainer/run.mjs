import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, join } from "node:path";
import { createCandidateReviewStore } from "../candidate-review.mjs";
import { reviewDatabase } from "../candidate-review-run.mjs";
import { resolveStorageConfig } from "../storage-config.mjs";
import {
  createExplainerWorkflow,
  readJson,
  importNarration,
} from "./workflow.mjs";
import { explainerGenerator } from "./generation.mjs";
import { renderExplainer } from "./render.mjs";
import { prepareNarration } from "./narration.mjs";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export async function runExplainerRequest(input, environment = process.env) {
  const { reviewId, action, revision, data, hash } = input;
  if (
    typeof reviewId !== "string" ||
    (!Number.isInteger(revision) && action !== "get")
  )
    throw Error("Supply review identity and current revision");
  const store = createCandidateReviewStore(reviewDatabase(environment));
  try {
    const workflow = createExplainerWorkflow({
      store,
      root: resolveStorageConfig(environment).dataRoot,
    });
    const operations = {
      get: async () => {
        const p = workflow.get(reviewId);
        const documents = {};
        for (const name of ["research", "script", "audio", "plan", "render"])
          if (p[name]) documents[name] = await workflow.load(p[name]);
        return { ...p, documents };
      },
      research: () => workflow.research(reviewId, revision, data),
      script: () => workflow.script(reviewId, revision, data),
      draft: () =>
        workflow.draft(
          reviewId,
          revision,
          explainerGenerator("script", environment, projectRoot),
        ),
      approve_script: () => workflow.approveScript(reviewId, revision, hash),
      narrate: () =>
        workflow.narration(reviewId, revision, prepareNarration(environment)),
      import_audio: () =>
        workflow.narration(reviewId, revision, ({ script }) =>
          importNarration(data.directory, script),
        ),
      accept_audio: () => workflow.acceptNarration(reviewId, revision, hash),
      scenes: () => workflow.scenes(reviewId, revision, data),
      plan: () =>
        workflow.plan(
          reviewId,
          revision,
          explainerGenerator("scenes", environment, projectRoot),
        ),
      render: () =>
        workflow.render(
          reviewId,
          revision,
          renderExplainer({
            projectRoot,
            assetsDir:
              environment.AUDIOGRAM_PRESENTER_ASSETS ??
              join(projectRoot, "public/generated/presenter-likeness"),
            browser: environment.CHROME_PATH,
          }),
        ),
      recover_render: () => workflow.recover(reviewId, revision, hash),
    };
    if (!Object.hasOwn(operations, action))
      throw Error("Unknown explainer action");
    return await operations[action]();
  } finally {
    store.close();
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { values } = parseArgs({
    options: {
      request: { type: "string" },
      action: { type: "string" },
      review: { type: "string" },
      revision: { type: "string" },
      input: { type: "string" },
      hash: { type: "string" },
    },
  });
  try {
    const request = values.request
      ? await readJson(values.request)
      : {
          action: values.action,
          reviewId: values.review,
          revision: Number(values.revision),
          hash: values.hash,
          data: values.input ? await readJson(values.input) : undefined,
        };
    console.log(JSON.stringify(await runExplainerRequest(request)));
  } catch (error) {
    console.error(
      JSON.stringify({
        error:
          error instanceof Error ? error.message : "Explainer action failed",
      }),
    );
    process.exitCode = 1;
  }
}
