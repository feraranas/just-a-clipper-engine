import { resolveTemplateSelection } from "../src/templates/catalog.mjs";
export const resolveTemplateSelectionConfig = ({
  request = {},
  environment = {},
} = {}) => {
  if (!request || typeof request !== "object" || Array.isArray(request))
    return resolveTemplateSelection(request);
  const fields = {
    templateId: "AUDIOGRAM_TEMPLATE",
    templateVersion: "AUDIOGRAM_TEMPLATE_VERSION",
    variationId: "AUDIOGRAM_VARIATION",
  };
  const input = {};
  for (const [field, name] of Object.entries(fields)) {
    if (environment[name] !== undefined) input[field] = environment[name];
  }
  return resolveTemplateSelection({ ...input, ...request });
};
