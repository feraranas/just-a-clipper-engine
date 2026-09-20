import assert from "node:assert/strict";
import test from "node:test";

import { resolvePackageVersion } from "./youtube-pipeline-config.mjs";

test("package version prefers the new variable and supports the legacy fallback", () => {
  assert.equal(
    resolvePackageVersion({
      AUDIOGRAM_PACKAGE_VERSION: "v3",
      AUDIOGRAM_TREATMENT_VERSION: "legacy",
    }),
    "v3",
  );
  assert.equal(
    resolvePackageVersion({ AUDIOGRAM_TREATMENT_VERSION: "legacy" }),
    "legacy",
  );
  assert.equal(resolvePackageVersion({}), "v1");
});
