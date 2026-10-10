import { resolveStorageConfig } from "./storage-config.mjs";
export const defaultPublishingAccountId = "local-approval";

export const resolveInstagramConfig = (environment = process.env) => {
  const token = environment.INSTAGRAM_PAGE_ACCESS_TOKEN;
  if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token))
    throw new Error("Page token required without newlines");
  const accountId = environment.INSTAGRAM_ACCOUNT_ID;
  const pageId = environment.INSTAGRAM_PAGE_ID;
  for (const id of [accountId, pageId])
    if (typeof id !== "string" || !/^[0-9]+$/.test(id))
      throw new Error("Numeric account and Page IDs required");
  const version = environment.INSTAGRAM_GRAPH_VERSION ?? "v26.0";
  if (!/^v[0-9]+\.[0-9]+$/.test(version))
    throw new Error("Valid Graph version required");
  return { token, accountId, pageId, version, username: "theballooninquiries" };
};

export const resolvePublishingAccountId = (environment = process.env) =>
  typeof environment.INSTAGRAM_ACCOUNT_ID === "string" &&
  environment.INSTAGRAM_ACCOUNT_ID.trim() !== ""
    ? environment.INSTAGRAM_ACCOUNT_ID
    : defaultPublishingAccountId;

export const resolvePipelineLogPath = (environment = process.env) =>
  resolveStorageConfig(environment).pipelineLog;

export const resolvePublishingLedgerPath = (environment = process.env) =>
  resolveStorageConfig(environment).publishingDb;
