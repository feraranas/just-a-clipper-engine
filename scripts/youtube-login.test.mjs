import test from "node:test";
import assert from "node:assert/strict";

import { resolveYoutubeOAuthPaths } from "./youtube-login.mjs";

test("YouTube login uses explicit credential paths when configured", () => {
  assert.deepEqual(resolveYoutubeOAuthPaths({
    AUDIOGRAM_GOOGLE_CLIENT_PATH: "/tmp/client.json",
    AUDIOGRAM_GOOGLE_TOKEN_PATH: "/tmp/token.json",
  }), { clientPath: "/tmp/client.json", tokenPath: "/tmp/token.json" });
});

test("YouTube login has stable application-support defaults", () => {
  const paths = resolveYoutubeOAuthPaths({});
  assert.match(paths.clientPath, /Library\/Application Support\/Audiogram Inbox\/google-oauth-client\.json$/);
  assert.match(paths.tokenPath, /Library\/Application Support\/Audiogram Inbox\/google-oauth-token\.json$/);
});
