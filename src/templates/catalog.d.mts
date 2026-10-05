import type { AudiogramCompositionSchemaType } from "../Audiogram/schema";
export type TemplateSelection = {
  templateId: string;
  templateVersion: string;
  variationId: string;
};
export type ResolvedTemplateSelection = {
  selection: TemplateSelection;
  treatment: { id: string; version: string };
  compositionId: string;
  renderKey: string;
};
export type TemplateCatalogEntry = {
  readonly id: string;
  readonly version: string;
  readonly label: string;
  readonly defaultVariationId: string;
  readonly variations: readonly {
    readonly id: string;
    readonly label: string;
    readonly treatment: { readonly id: string; readonly version: string };
    readonly compositionId: string;
  }[];
};
export const classicDefaults: Pick<
  AudiogramCompositionSchemaType,
  | "titleColor"
  | "captionsTextColor"
  | "onlyDisplayCurrentSentence"
  | "visualizer"
>;
export function listTemplates(): readonly TemplateCatalogEntry[];
export function resolveTemplateSelection(
  input?: Partial<TemplateSelection>,
): ResolvedTemplateSelection;
