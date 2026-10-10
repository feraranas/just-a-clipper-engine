import process from "node:process";
import path from "node:path";
import { URL } from "node:url";
import { resolveSelectionConfig } from "../../scripts/youtube-pipeline-config.mjs";

export function validateMcpRuntimeConfig(environment = process.env) {
  const selection = resolveSelectionConfig(environment);
  const authPath = environment.AUDIOGRAM_CHATGPT_AUTH_PATH;
  const authRelative = authPath === undefined ? null : path.relative(
    path.resolve(environment.AUDIOGRAM_PROJECT_ROOT ?? process.cwd()), authPath,
  );
  if (selection.providerId === "chatgpt-oauth" && authPath !== undefined &&
      (!path.isAbsolute(authPath) || authPath !== path.resolve(authPath) ||
       (authRelative !== ".." && !authRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(authRelative)))) {
    throw new Error("AUDIOGRAM_CHATGPT_AUTH_PATH must be an absolute normalized path outside the repository");
  }

  const hasJevEndpoint = Boolean(environment.TYPESAFE_JEV_ENDPOINT);
  const hasJevApiKey = Boolean(environment.TYPESAFE_JEV_API_KEY);
  if (hasJevEndpoint !== hasJevApiKey) {
    throw new Error(
      "TYPESAFE_JEV_ENDPOINT and TYPESAFE_JEV_API_KEY must be provided together",
    );
  }
  if (hasJevEndpoint) {
    let endpoint;
    try { endpoint = new URL(environment.TYPESAFE_JEV_ENDPOINT); } catch { /* Report only the setting name. */ }
    if (!endpoint || endpoint.protocol !== "https:" || !environment.TYPESAFE_JEV_ENDPOINT.startsWith("https://")) {
      throw new Error("TYPESAFE_JEV_ENDPOINT must be an HTTPS URL");
    }
    if (!environment.TYPESAFE_JEV_API_KEY.trim()) {
      throw new Error("TYPESAFE_JEV_API_KEY must be nonblank");
    }
  }
}
