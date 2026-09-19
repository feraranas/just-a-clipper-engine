import assert from "node:assert/strict";
import test from "node:test";

import {sanitizeErrorDiagnostic} from "./error-diagnostics.mjs";

test("error diagnostics redact credentials and remain deliberately bounded", () => {
  const error = new Error(
    `yt-dlp --api-key super-secret https://example.test/video?access_token=url-secret ${"x".repeat(5_000)}`,
  );
  error.stderr = "Authorization: Bearer bearer-secret\nrefresh_token=json-secret";

  const diagnostic = sanitizeErrorDiagnostic(error);

  assert.ok(diagnostic.length <= 2_000);
  assert.doesNotMatch(
    diagnostic,
    /super-secret|url-secret|bearer-secret|json-secret/,
  );
  assert.match(diagnostic, /\[REDACTED\]/);
  assert.match(diagnostic, /\[truncated\]$/);
});
