import test from "node:test";
import assert from "node:assert/strict";

import {
  defaultPublishingAccountId,
  resolvePublishingAccountId,
  resolvePublishingLedgerPath,
  resolveInstagramConfig,
} from "./publishing-config.mjs";

test("native publishing fails closed without explicit valid credentials and target identity", () => {
  assert.throws(() => resolveInstagramConfig({}), /required/);
  const env = { INSTAGRAM_PAGE_ACCESS_TOKEN: "test-token", INSTAGRAM_ACCOUNT_ID: "2", INSTAGRAM_PAGE_ID: "1", INSTAGRAM_USERNAME: "another_account" };
  assert.equal(resolveInstagramConfig(env).username, "another_account");
  assert.equal(resolveInstagramConfig(env).version, "v26.0");
  for (const patch of [{ INSTAGRAM_USERNAME: undefined }, { INSTAGRAM_USERNAME: "" }, { INSTAGRAM_USERNAME: "@account" }, { INSTAGRAM_USERNAME: "a\nb" }, { INSTAGRAM_ACCOUNT_ID: "local-approval" }, { INSTAGRAM_PAGE_ID: "../x" }, { INSTAGRAM_GRAPH_VERSION: "bad" }, { INSTAGRAM_PAGE_ACCESS_TOKEN: "a\nb" }]) assert.throws(() => resolveInstagramConfig({ ...env, ...patch }));
});

test("local approval is the default publishing account", () => {
  assert.equal(resolvePublishingAccountId({}), defaultPublishingAccountId);
  assert.equal(resolvePublishingAccountId({ INSTAGRAM_ACCOUNT_ID: "" }), defaultPublishingAccountId);
  assert.equal(resolvePublishingAccountId({ INSTAGRAM_ACCOUNT_ID: "real-account" }), "real-account");
});

test("publishing ledger path supports an explicit override", () => {
  assert.equal(resolvePublishingLedgerPath({ INSTAGRAM_PUBLISHING_DB_PATH: "/tmp/publishing.sqlite" }), "/tmp/publishing.sqlite");
  assert.match(resolvePublishingLedgerPath({}), /Library\/Application Support\/Audiogram Inbox\/instagram-publishing\.sqlite$/);
});
