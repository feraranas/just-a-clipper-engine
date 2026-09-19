const defaultMaximumLength = 2_000;
const truncatedSuffix = "…[truncated]";

const errorText = (error) => {
  if (error instanceof Error) {
    const stderr =
      typeof error.stderr === "string"
        ? error.stderr
        : Buffer.isBuffer(error.stderr)
          ? error.stderr.toString("utf8")
          : "";
    return stderr && !error.message.includes(stderr)
      ? `${error.message}\n${stderr}`
      : error.message;
  }
  return String(error);
};

const redactSecrets = (value) =>
  value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(
      /((?:access_token|refresh_token|client_secret|api_key|api-key|password|authorization|token|code)["']?\s*[:=]\s*["']?)[^\s&"']+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(--(?:api-key|client-secret|password|token)\s+)[^\s]+/gi,
      "$1[REDACTED]",
    );

export const sanitizeErrorDiagnostic = (
  error,
  {maximumLength = defaultMaximumLength} = {},
) => {
  if (!Number.isInteger(maximumLength) || maximumLength <= truncatedSuffix.length) {
    throw new Error("maximumLength must be a positive integer larger than the suffix");
  }
  const redacted = redactSecrets(errorText(error));
  if (redacted.length <= maximumLength) return redacted;
  return `${redacted.slice(0, maximumLength - truncatedSuffix.length)}${truncatedSuffix}`;
};
