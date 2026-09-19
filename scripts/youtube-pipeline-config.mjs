export const resolvePackageVersion = (environment) =>
  environment.AUDIOGRAM_PACKAGE_VERSION ??
  environment.AUDIOGRAM_TREATMENT_VERSION ??
  "v1";
