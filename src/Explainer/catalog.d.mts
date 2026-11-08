import { z } from "zod";
export type Scene = {
  segmentId: string;
  kind: "comparison" | "process" | "branch";
  version: 1;
  title: string;
  items: string[];
};
export const sceneSchema: z.ZodType<Scene>;
export const scenePlanSchema: z.ZodType<{ scenes: Scene[] }>;
export function validateScenePlan(
  plan: unknown,
  script: { segments: { id: string; text: string }[] },
): { scenes: Scene[] };
export function listSceneBlocks(): {
  id: string;
  version: number;
  purpose: string;
  minItems: number;
  maxItems: number;
}[];
