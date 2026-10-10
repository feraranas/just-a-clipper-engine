const phases = new Set(["not_started", "in_progress", "complete", "error"]);
const statuses = new Set(["IN_PROGRESS", "FINISHED", "ERROR", "EXPIRED", "PUBLISHED"]);
const operations = new Set(["verify_page", "verify_account", "create_container", "upload_video", "container_status", "publish_container", "published_media"]);
const errors = new Set(["REQUEST_TIMEOUT", "NETWORK_ERROR", "PROVIDER_ERROR", "INVALID_RESPONSE", "RETRY_LATER", "ACCOUNT_MISMATCH"]);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

// Reapply the allowlist at persistence, not only at the HTTP boundary.
export const sanitizePublishingDiagnostic = (input = {}) => {
  const output = {};
  for (const [key, values] of [["operation", operations], ["errorCode", errors], ["statusCode", statuses], ["uploadPhase", phases], ["processingPhase", phases]]) {
    if (values.has(input[key])) output[key] = input[key];
  }
  for (const key of ["providerCode", "providerSubcode", "bytesTransferred", "sourceFileSize"]) {
    if (integer(input[key])) output[key] = input[key];
  }
  if (integer(input.httpStatus) && input.httpStatus >= 100 && input.httpStatus <= 599) output.httpStatus = input.httpStatus;
  if (Array.isArray(input.providerCodes)) output.providerCodes = input.providerCodes.filter(integer).slice(0, 20);
  return output;
};
