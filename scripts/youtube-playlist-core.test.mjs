import assert from "node:assert/strict";
import test from "node:test";

import {collectPlaylistItems} from "./youtube-playlist-core.mjs";

test("collectPlaylistItems returns videos from every page", async () => {
  const pages = new Map([
    [undefined, {items: [{snippet: {title: "One", resourceId: {videoId: "one"}}}], nextPageToken: "next"}],
    ["next", {items: [{snippet: {title: "Two", resourceId: {videoId: "two"}}}]}],
  ]);

  const videos = await collectPlaylistItems((pageToken) => pages.get(pageToken));

  assert.deepEqual(videos, [
    {title: "One", videoId: "one", url: "https://www.youtube.com/watch?v=one"},
    {title: "Two", videoId: "two", url: "https://www.youtube.com/watch?v=two"},
  ]);
});
