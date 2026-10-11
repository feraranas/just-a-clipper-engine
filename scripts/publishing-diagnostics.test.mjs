import assert from "node:assert/strict";
import test from "node:test";
import { sanitizePublishingDiagnostic } from "./publishing-diagnostics.mjs";

test("preserves signed provider codes but rejects negative byte counts", () => {
  assert.deepEqual(sanitizePublishingDiagnostic({
    providerCode: -1, providerSubcode: -2,
    providerCodes: [-1, -2, 0, 1363008, 1.5, Infinity, "secret"],
    bytesTransferred: -1, sourceFileSize: -2,
  }), {providerCode: -1, providerSubcode: -2, providerCodes: [-1, -2, 0, 1363008]});
  assert.deepEqual(sanitizePublishingDiagnostic({bytesTransferred:0,sourceFileSize:12}),
    {bytesTransferred:0,sourceFileSize:12});
});
