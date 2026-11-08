import { z } from "zod";
const label = z.string().trim().min(1).max(70);
export const sceneSchema = z
  .strictObject({
    segmentId: z.string().min(1).max(80),
    kind: z.enum(["comparison", "process", "branch"]),
    version: z.literal(1),
    title: label,
    items: z.array(label).min(2).max(5),
  })
  .superRefine((s, c) => {
    if (s.kind === "comparison" && s.items.length !== 2)
      c.addIssue({
        code: "custom",
        message: "Comparison requires two alternatives",
      });
    if (s.kind === "branch" && s.items.length !== 4)
      c.addIssue({
        code: "custom",
        message: "Branch requires four history labels",
      });
  });
export const scenePlanSchema = z.strictObject({
  scenes: z.array(sceneSchema).min(1).max(20),
});
export function validateScenePlan(plan, script) {
  const p = scenePlanSchema.parse(plan);
  if (
    p.scenes.length !== script.segments.length ||
    p.scenes.some((s, i) => s.segmentId !== script.segments[i].id)
  )
    throw Error("Scene plan does not match script segments");
  return p;
}
export function listSceneBlocks() {
  return [
    {
      id: "comparison",
      version: 1,
      purpose: "Contrast two alternatives",
      minItems: 2,
      maxItems: 2,
    },
    {
      id: "process",
      version: 1,
      purpose: "Show ordered steps or decisions",
      minItems: 2,
      maxItems: 5,
    },
    {
      id: "branch",
      version: 1,
      purpose: "Show a shared history diverging",
      minItems: 4,
      maxItems: 4,
    },
  ];
}
