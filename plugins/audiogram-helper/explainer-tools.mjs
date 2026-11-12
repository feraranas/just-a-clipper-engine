import { z } from "zod";
import {
  researchSchema,
  scriptSchema,
} from "../../scripts/explainer/contracts.mjs";
import { scenePlanSchema } from "../../src/Explainer/catalog.mjs";
import { listSceneBlocks } from "../../src/Explainer/catalog.mjs";
import { ScriptApprovalRequiredError } from "./explainer-runner.mjs";
export function registerExplainerTools(server, runner) {
  server.registerTool(
    "list_scene_blocks",
    {
      description:
        "List the implemented versioned explanation scene blocks. These are project components, not Remotion browser tools.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(listSceneBlocks()) }],
    }),
  );
  server.registerTool(
    "continue_explainer",
    {
      description:
        "Continue an explicitly selected candidate. First get saved progress. Submit researched source passages from web search with research, then draft or submit a script. If a draft is unconfirmed, inspect its outcome first; recover_draft clears only that attempt using its current revision and pending token in hash, without making a new model call. Start another draft only when explicitly requested. Show the exact script to the user before approve_script. Generate narration only after that approval. For audio review, get returns documents.audio.path and documents.audio.sha256: tell the user to open the path on the machine running the service and listen, then use the hash in accept_audio only after explicit acceptance. After rendering, get returns documents.render.path, a local file path, not a hosted link; tell the user how to open it on that machine. If the user cannot access that machine, playback is unavailable. Every mutation requires the current revision. Render queues locally but never approves or publishes. If queue registration failed, use queue_render with the current revision to retry. Long steps run once in the existing local worker pattern; poll get with the returned operationId. Artwork and Rhubarb must be configured locally.",
      inputSchema: z.strictObject({
        reviewId: z.string().uuid(),
        action: z.enum([
          "get",
          "research",
          "script",
          "draft",
          "approve_script",
          "narrate",
          "accept_audio",
          "scenes",
          "plan",
          "render",
          "queue_render",
          "recover_render",
          "recover_draft",
        ]),
        revision: z.number().int().nonnegative().optional(),
        operationId: z.string().uuid().optional(),
        data: z
          .union([researchSchema, scriptSchema, scenePlanSchema])
          .optional(),
        hash: z.string().max(100).optional(),
      }),
    },
    async (args) => {
      try {
        const result = await runner.run(args);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: { contractVersion: 1, ...result },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                error instanceof ScriptApprovalRequiredError
                  ? "Approve the exact current script before starting narration."
                  : "The explainer step could not start. Check the current revision, required approvals, and local configuration.",
            },
          ],
        };
      }
    },
  );
}
