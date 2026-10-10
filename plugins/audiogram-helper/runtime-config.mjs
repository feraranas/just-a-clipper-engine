import process from "node:process";
import { resolveSelectionConfig } from "../../scripts/youtube-pipeline-config.mjs";

export function validateMcpRuntimeConfig(environment = process.env) {
  resolveSelectionConfig(environment);

  const hasJevEndpoint = Boolean(environment.TYPESAFE_JEV_ENDPOINT);
  const hasJevApiKey = Boolean(environment.TYPESAFE_JEV_API_KEY);
  if (hasJevEndpoint !== hasJevApiKey) {
    throw new Error(
      "TYPESAFE_JEV_ENDPOINT and TYPESAFE_JEV_API_KEY must be provided together",
    );
  }
}
