import assert from "node:assert/strict";
import test from "node:test";

import {
  findPlaylistByTitle,
  mergeOAuthTokens,
  parseInstalledClient,
} from "./youtube-auth-core.mjs";

test("parseInstalledClient reads a desktop OAuth client", () => {
  assert.deepEqual(
    parseInstalledClient({
      installed: {
        client_id: "client-id",
        client_secret: "client-secret",
        redirect_uris: ["http://localhost"],
      },
    }),
    {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "http://localhost",
    },
  );
});

test("mergeOAuthTokens preserves an existing refresh token", () => {
  assert.deepEqual(
    mergeOAuthTokens(
      {refresh_token: "keep-me", access_token: "old"},
      {access_token: "new", expiry_date: 123},
    ),
    {refresh_token: "keep-me", access_token: "new", expiry_date: 123},
  );
});

test("findPlaylistByTitle follows pagination", async () => {
  const pages = new Map([
    [undefined, {items: [{id: "other", snippet: {title: "Other"}}], nextPageToken: "next"}],
    ["next", {items: [{id: "inbox-id", snippet: {title: "Audiogram Inbox"}}]}],
  ]);

  const playlist = await findPlaylistByTitle(
    async (pageToken) => pages.get(pageToken),
    "Audiogram Inbox",
  );

  assert.deepEqual(playlist, {id: "inbox-id", title: "Audiogram Inbox"});
});
