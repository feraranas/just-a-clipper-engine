import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createTaskGenerationProvider } from "./structured-generation-provider.mjs";
import { resolveSelectionConfig } from "./youtube-pipeline-config.mjs";
test("explicit task contract uses the existing provider transport and validates its own output", async () => {
  const outputSchema = z.strictObject({ title: z.string() });
  const jsonSchema = z.toJSONSchema(outputSchema);
  let body;
  const cfg = resolveSelectionConfig({
    AUDIOGRAM_LLM_PROVIDER: "openai-api",
    OPENAI_API_KEY: "fake",
  });
  const provider = createTaskGenerationProvider(
    cfg,
    {
      name: "explainer_test",
      instructions: "Explain",
      jsonSchema,
      outputSchema,
    },
    {
      apiKey: "fake",
      fetch: async (_url, options) => {
        body = JSON.parse(options.body);
        return new Response(
          JSON.stringify({
            id: "resp_test",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                status: "completed",
                content: [
                  { type: "output_text", text: '{"title":"Safe actions"}' },
                ],
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    },
  );
  assert.equal(
    (
      await provider.generateStructured({
        instructions: "Explain",
        input: "{}",
        jsonSchema,
      })
    ).parsed.title,
    "Safe actions",
  );
  assert.equal(body.text.format.name, "explainer_test");
  assert.equal(body.text.format.schema.properties.title.type, "string");
  await assert.rejects(
    provider.generateStructured({
      instructions: "Different",
      input: "{}",
      jsonSchema,
    }),
  );
});
