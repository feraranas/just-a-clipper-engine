import { isAbsolute } from "node:path";

const defaultMaximumLength = 2_000;
const truncatedSuffix = "…[truncated]";
const safeCodePattern = /^[a-z][a-z0-9_]{0,63}$/;
const providerIdPattern = /^[a-z][a-z0-9-]{0,63}$/;

export class SafeDiagnosticError extends Error {
  constructor({ providerId, code, httpStatus }) {
    if (
      typeof providerId !== "string" ||
      !providerIdPattern.test(providerId) ||
      typeof code !== "string" ||
      !safeCodePattern.test(code) ||
      (httpStatus !== undefined &&
        (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599))
    )
      throw new Error("Invalid safe diagnostic error fields");
    super(code);
    this.name = "SafeDiagnosticError";
    this.providerId = providerId;
    this.code = code;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

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

const defaultAuthPathPattern =
  /\/Users\/[^/\n]+\/Library\/Application Support\/Audiogram Inbox\/chatgpt-oauth\/auth\.json/g;

const redactSecrets = (value, sensitivePaths) => {
  let redacted = value;
  for (const path of [...sensitivePaths].sort(
    (left, right) => right.length - left.length,
  ))
    redacted = redacted.replaceAll(path, "[REDACTED]");
  return redacted
    .replace(defaultAuthPathPattern, "[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(
      /(authorization["']?\s*[:=]\s*)(?:\{[^}\n]*\}|[^\s,\n]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:access_token|accessToken|refresh_token|refreshToken|id_token|idToken|client_secret|clientSecret|api_key|api-key|password|oauth_code|authorization_code|token|code)["']?\s*[:=]\s*["']?)[^\s&,}"']+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(--(?:api-key|client-secret|password|token)\s+)[^\s]+/gi,
      "$1[REDACTED]",
    )
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\b/g,
      "[REDACTED]",
    );
};

export const sanitizeErrorDiagnostic = (
  error,
  { maximumLength = defaultMaximumLength, sensitivePaths = [] } = {},
) => {
  if (
    !Number.isInteger(maximumLength) ||
    maximumLength <= truncatedSuffix.length
  ) {
    throw new Error(
      "maximumLength must be a positive integer larger than the suffix",
    );
  }
  if (
    !Array.isArray(sensitivePaths) ||
    sensitivePaths.some(
      (path) => typeof path !== "string" || !isAbsolute(path) || path === "/",
    )
  )
    throw new Error("sensitivePaths must contain specific absolute paths");
  if (error instanceof SafeDiagnosticError) {
    const safe = { providerId: error.providerId, code: error.code };
    if (error.httpStatus !== undefined) safe.httpStatus = error.httpStatus;
    return JSON.stringify(safe);
  }
  const redacted = redactSecrets(errorText(error), sensitivePaths);
  if (redacted.length <= maximumLength) return redacted;
  return `${redacted.slice(0, maximumLength - truncatedSuffix.length)}${truncatedSuffix}`;
};
