const treatmentKey = (id, version) => `${id}@${version}`;

const requireAssets = (clipPackage, roles) => {
  const assets = new Map(
    (clipPackage.assets ?? []).map((asset) => [asset.role, asset.relativePath]),
  );
  for (const role of roles) {
    if (!assets.has(role)) {
      throw new Error(`Missing required asset: ${role}`);
    }
  }
  return assets;
};

const toPublicFileName = (relativePath) => {
  const prefix = "public/";
  if (!relativePath.startsWith(prefix) || relativePath.length === prefix.length) {
    throw new Error(`Treatment asset must be inside public/: ${relativePath}`);
  }
  return relativePath.slice(prefix.length);
};

export const audiogramBasicTreatment = Object.freeze({
  id: "audiogram-basic",
  version: "1",
  compositionId: "AudiogramBasic",
  requiredAssetRoles: Object.freeze(["audio", "captions", "thumbnail"]),
  output: Object.freeze({extension: "mp4", codec: "h264"}),
  buildProps: (clipPackage) => {
    const assets = requireAssets(clipPackage, ["audio", "captions", "thumbnail"]);
    return {
      title: clipPackage.title,
      audioFileName: toPublicFileName(assets.get("audio")),
      captionsFileName: toPublicFileName(assets.get("captions")),
      coverImageFileName: toPublicFileName(assets.get("thumbnail")),
    };
  },
});

export const createTreatmentRegistry = (treatments) => {
  const entries = new Map();
  for (const treatment of treatments) {
    const key = treatmentKey(treatment.id, treatment.version);
    if (entries.has(key)) {
      throw new Error(`Duplicate treatment: ${key}`);
    }
    entries.set(key, treatment);
  }

  return Object.freeze({
    get: (id, version) => {
      const key = treatmentKey(id, version);
      const treatment = entries.get(key);
      if (!treatment) {
        throw new Error(`Unknown treatment: ${key}`);
      }
      return treatment;
    },
  });
};

export const treatmentRegistry = createTreatmentRegistry([
  audiogramBasicTreatment,
]);
