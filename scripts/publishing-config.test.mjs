import test from "node:test";
import assert from "node:assert/strict";

import {
  defaultPublishingAccountId,
  resolvePublishingAccountId,
  resolvePublishingLedgerPath,
} from "./publishing-config.mjs";

test("local approval is the default publishing account", () => {
  assert.equal(resolvePublishingAccountId({}), defaultPublishingAccountId);
  assert.equal(resolvePublishingAccountId({ INSTAGRAM_ACCOUNT_ID: "" }), defaultPublishingAccountId);
  assert.equal(resolvePublishingAccountId({ INSTAGRAM_ACCOUNT_ID: "real-account" }), "real-account");
});

test("publishing ledger path supports an explicit override", () => {
  assert.equal(resolvePublishingLedgerPath({ INSTAGRAM_PUBLISHING_DB_PATH: "/tmp/publishing.sqlite" }), "/tmp/publishing.sqlite");
  assert.match(resolvePublishingLedgerPath({}), /Library\/Application Support\/Audiogram Inbox\/instagram-publishing\.sqlite$/);
});
