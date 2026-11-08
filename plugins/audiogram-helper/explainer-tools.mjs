import { z } from "zod";
import {
  researchSchema,
  scriptSchema,
} from "../../scripts/explainer/contracts.mjs";
import { scenePlanSchema } from "../../src/Explainer/catalog.mjs";
import { listSceneBlocks } from "../../src/Explainer/catalog.mjs";
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
        "Continue an explicitly selected candidate. First get saved progress. Submit researched source passages from web search with research, then draft or submit a script. Show the exact script to the user before approve_script. Generate narration only after that approval; show it before accept_audio. Then plan and render. Every mutation requires the current revision. render never publishes. Long steps run once in the existing local worker pattern; poll get with the returned operationId to see completion or startup failures. Artwork and Rhubarb must be configured locally.",
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
          "recover_render",
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
      } catch {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "The explainer step could not start. Check the current revision, required approvals, and local configuration.",
            },
          ],
        };
      }
    },
  );
}
