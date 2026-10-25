// Public neutral samples only. Add a mapping after verifying its deployed media.
const previews = new Map([
  [JSON.stringify(["classic", "1", "default"]), {
    status: "video-configured",
    pageUrl: "https://media.ferarana.work/templates/classic/v1/",
    posterUrl: "https://media.ferarana.work/templates/classic/v1/poster.jpg",
    videoUrl: "https://media.ferarana.work/templates/classic/v1/demo.mp4",
  }],
]);

export function findTemplatePreview(templateId, templateVersion, variationId) {
  const preview = previews.get(JSON.stringify([templateId, templateVersion, variationId]));
  return preview ? { ...preview } : undefined;
}
