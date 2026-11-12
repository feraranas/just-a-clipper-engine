import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runExplainerRequest } from "../../scripts/explainer/run.mjs";
import { resolveStorageConfig } from "../../scripts/storage-config.mjs";
export class ScriptApprovalRequiredError extends Error {
  constructor() {
    super("Approve the exact current script before starting narration.");
  }
}
export function createExplainerRunner({
  projectRoot,
  environment = process.env,
  launch = spawn,
  requestRunner = runExplainerRequest,
}) {
  return {
    async run(args) {
      if (args.action === "get" && args.operationId) {
        if (!/^[a-f0-9-]{36}$/i.test(args.operationId))
          throw Error("Invalid operation ID");
        const folder = join(
          resolveStorageConfig(environment).dataRoot,
          "explainer-requests",
        );
        const request = JSON.parse(
          await readFile(join(folder, `${args.operationId}.json`), "utf8"),
        );
        if (request.reviewId !== args.reviewId)
          throw Error("Operation belongs to another review");
        let operation;
        try {
          operation = JSON.parse(
            await readFile(
              join(folder, `${args.operationId}.outcome.json`),
              "utf8",
            ),
          );
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          operation = {
            state: "unconfirmed",
            message:
              "No completion record. Inspect saved progress before retrying.",
          };
        }
        return {
          ...(await requestRunner(
            { action: "get", reviewId: args.reviewId },
            environment,
          )),
          operationId: args.operationId,
          operation,
        };
      }
      if (!["draft", "narrate", "plan", "render"].includes(args.action))
        return requestRunner(args, environment);
      if (!Number.isInteger(args.revision))
        throw Error("Current revision is required");
      const before = await requestRunner(
        { action: "get", reviewId: args.reviewId },
        environment,
      );
      if (before.revision !== args.revision || before.pending)
        throw Error("Refresh saved progress before starting");
      if (
        args.action === "narrate" &&
        (!before.script?.hash || before.scriptApproval !== before.script.hash)
      )
        throw new ScriptApprovalRequiredError();
      const folder = join(
        resolveStorageConfig(environment).dataRoot,
        "explainer-requests",
      );
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const operationId = randomUUID(),
        request = join(folder, `${operationId}.json`),
        outcome = join(folder, `${operationId}.outcome.json`);
      await writeFile(request, JSON.stringify(args), {
        flag: "wx",
        mode: 0o600,
      });
      const child = launch(
        process.execPath,
        [join(projectRoot, "scripts/explainer/run.mjs"), "--request", request],
        {
          cwd: projectRoot,
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let outputText = "";
      child.stdout?.on("data", (chunk) => {
        if (outputText.length <= 8 * 1024 * 1024)
          outputText += chunk.toString();
      });
      let errorText = "";
      child.stderr?.on("data", (chunk) => {
        if (errorText.length < 4096)
          errorText += chunk.toString().slice(0, 4096 - errorText.length);
      });
      const save = (value) =>
        writeFile(outcome, JSON.stringify(value), { mode: 0o600 }).catch(
          () => {},
        );
      child.once("error", () =>
        save({ state: "failed", message: "Worker failed to start" }),
      );
      child.once("close", (code) => {
        let queueState;
        if (code === 0 && args.action === "render") {
          try {
            queueState = JSON.parse(outputText).publishingQueue?.state;
          } catch {
            /* report uncertain */
          }
        }
        const queueFailure =
          code === 0 &&
          args.action === "render" &&
          ![
            "queued",
            "approved",
            "uploading",
            "container_created",
            "processing",
            "published",
            "failed",
            "unknown",
          ].includes(queueState);
        save({
          state:
            code !== 0
              ? "failed"
              : queueFailure
                ? "queue_registration_failed"
                : "complete",
          message:
            code !== 0
              ? "Inspect saved progress and local worker diagnostics"
              : queueFailure
                ? "Render saved; inspect progress and use queue_render to reconcile its local approval queue entry."
                : "Read saved progress",
          diagnostic: errorText,
        });
      });
      return {
        reviewId: args.reviewId,
        operationId,
        status: "started",
        revision: before.revision,
      };
    },
  };
}
