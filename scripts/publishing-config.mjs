import { homedir } from "node:os";
import { join } from "node:path";

const appSupportDirectory = join(
  homedir(),
  "Library",
  "Application Support",
  "Audiogram Inbox",
);

export const defaultPublishingAccountId = "local-approval";

export const resolvePublishingAccountId = (environment = process.env) =>
  typeof environment.INSTAGRAM_ACCOUNT_ID === "string" &&
  environment.INSTAGRAM_ACCOUNT_ID.trim() !== ""
    ? environment.INSTAGRAM_ACCOUNT_ID
    : defaultPublishingAccountId;

export const resolvePublishingLedgerPath = (environment = process.env) =>
  environment.INSTAGRAM_PUBLISHING_DB_PATH ??
  join(appSupportDirectory, "instagram-publishing.sqlite");
