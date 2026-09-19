const treatmentKey = (id, version) => `${id}@${version}`;

const assetPathsByRole = (clipPackage) =>
  new Map(
    (clipPackage.assets ?? []).map((asset) => [asset.role, asset.relativePath]),
  );

export const assertRequiredAssets = (treatment, clipPackage) => {
  const assets = new Map(
    (clipPackage.assets ?? []).map((asset) => [asset.role, asset.relativePath]),
  );
  for (const role of treatment.requiredAssetRoles) {
    if (!assets.get(role)) {
      throw new Error(`Missing required asset: ${role}`);
    }
  }
};

const assertNonemptyString = (value, label) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
};

const validateTreatmentDefinition = (treatment) => {
  assertNonemptyString(treatment.id, "id");
  assertNonemptyString(treatment.version, "version");
  assertNonemptyString(treatment.compositionId, "compositionId");
  if (!Array.isArray(treatment.requiredAssetRoles)) {
    throw new Error("requiredAssetRoles must be an array");
  }
  const roles = new Set();
  for (const role of treatment.requiredAssetRoles) {
    assertNonemptyString(role, "required asset role");
    if (roles.has(role)) {
      throw new Error(`Duplicate required asset role: ${role}`);
    }
    roles.add(role);
  }
  if (typeof treatment.buildProps !== "function") {
    throw new Error("buildProps must be a function");
  }
  if (!treatment.output || typeof treatment.output !== "object") {
    throw new Error("output must be an object");
  }
  assertNonemptyString(treatment.output.extension, "output.extension");
  assertNonemptyString(treatment.output.codec, "output.codec");
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
    assertRequiredAssets(audiogramBasicTreatment, clipPackage);
    const assets = assetPathsByRole(clipPackage);
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
    validateTreatmentDefinition(treatment);
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
