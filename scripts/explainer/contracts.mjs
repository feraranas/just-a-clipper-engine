import { z } from "zod";
export const sourceSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  url: z
    .string()
    .url()
    .max(2048)
    .refine((x) => ["http:", "https:"].includes(new URL(x).protocol)),
  title: z.string().min(1).max(240),
  passage: z.string().min(1).max(12000),
});
export const researchSchema = z
  .strictObject({
    summary: z.string().min(1).max(6000),
    sources: z.array(sourceSchema).min(1).max(20),
  })
  .refine(
    (r) => new Set(r.sources.map((s) => s.id)).size === r.sources.length,
    "Duplicate source IDs",
  );
export const scriptSchema = z.strictObject({
  title: z.string().min(1).max(100),
  segments: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
        text: z.string().trim().min(1).max(800),
        kind: z.enum(["factual", "illustration"]),
        sourceIds: z.array(z.string()).max(20),
      }),
    )
    .min(1)
    .max(20),
});
export function validateScript(input, research) {
  const script = scriptSchema.parse(input);
  const ids = new Set(research.sources.map((s) => s.id));
  if (new Set(script.segments.map((s) => s.id)).size !== script.segments.length)
    throw Error("Duplicate script segment IDs");
  for (const s of script.segments) {
    if (s.kind === "factual" && !s.sourceIds.length)
      throw Error("Factual segments need source references");
    if (s.sourceIds.some((id) => !ids.has(id)))
      throw Error("Unknown script source reference");
  }
  if (scriptText(script).length > 5000)
    throw Error("Script is too long for narration");
  return script;
}
export const scriptText = (script) =>
  script.segments.map((s) => s.text).join("\n");
