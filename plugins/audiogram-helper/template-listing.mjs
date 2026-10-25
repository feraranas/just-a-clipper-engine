import { z } from "zod";
import { listTemplates } from "../../src/templates/catalog.mjs";
import { findTemplatePreview } from "./template-previews.mjs";

const publicUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
});
const previewSchema = z.object({
  status: z.literal("video-configured"),
  pageUrl: publicUrl,
  posterUrl: publicUrl,
  videoUrl: publicUrl,
});

const text = z
  .string()
  .min(1)
  .refine((value) => value === value.trim());
const selection = z.object({
  templateId: text,
  templateVersion: text,
  variationId: text,
});
export const templateListingShape = {
  contractVersion: z.literal(1),
  templates: z.array(
    z.object({
      templateId: text,
      templateVersion: text,
      name: text,
      description: text,
      supportedInput: text,
      variations: z
        .array(z.object({ variationId: text, name: text, description: text, preview: previewSchema.optional() }))
        .min(1),
      defaultSelection: selection,
    }),
  ),
};
const catalogSchema = z.array(
  z.object({
    id: text,
    version: text,
    name: text,
    description: text,
    supportedInput: text,
    defaultVariationId: text,
    variations: z
      .array(
        z.object({
          id: text,
          label: text,
          description: text,
          treatment: z.object({ id: text, version: text }),
          compositionId: text,
        }),
      )
      .min(1),
  }),
);

export function buildTemplateListing(entries = listTemplates()) {
  const catalog = catalogSchema.parse(entries);
  const identities = new Set();
  const templates = catalog.map((t) => {
    const identity = JSON.stringify([t.id, t.version]);
    const variations = new Set(t.variations.map((v) => v.id));
    if (
      identities.has(identity) ||
      variations.size !== t.variations.length ||
      !variations.has(t.defaultVariationId)
    ) {
      throw new Error(
        "Invalid template catalog identity or default variation.",
      );
    }
    identities.add(identity);
    return {
      templateId: t.id,
      templateVersion: t.version,
      name: t.name,
      description: t.description,
      supportedInput: t.supportedInput,
      variations: t.variations.map((v) => {
        const preview = findTemplatePreview(t.id, t.version, v.id);
        return {
          variationId: v.id,
          name: v.label,
          description: v.description,
          ...(preview ? { preview } : {}),
        };
      }),
      defaultSelection: {
        templateId: t.id,
        templateVersion: t.version,
        variationId: t.defaultVariationId,
      },
    };
  });
  return z
    .object(templateListingShape)
    .parse({ contractVersion: 1, templates });
}
