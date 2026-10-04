import assert from "node:assert/strict";
import test from "node:test";

import {
  parseYouTubeVideoUrl,
  validateYouTubeMetadata,
} from "./youtube-url-core.mjs";

const videoId = "dQw4w9WgXcQ";
const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

test("normalizes supported YouTube video URL forms to one canonical URL", () => {
  const inputs = [
    canonicalUrl,
    `https://youtube.com/watch?v=${videoId}&list=PL123`,
    `https://m.youtube.com/watch?v=${videoId}`,
    `https://youtu.be/${videoId}?si=share`,
    `https://www.youtube.com/shorts/${videoId}`,
    `https://www.youtube.com/embed/${videoId}`,
    `https://www.youtube.com/live/${videoId}`,
  ];

  for (const input of inputs) {
    assert.deepEqual(parseYouTubeVideoUrl(input), {
      videoId,
      sourceUrl: canonicalUrl,
    });
  }
});

test("rejects malformed URLs and hosts outside the supported YouTube set", () => {
  for (const input of [
    "not a url",
    `https://youtube.com.evil.test/watch?v=${videoId}`,
    `https://evil.test/watch?v=${videoId}`,
    `https://user@youtube.com/watch?v=${videoId}`,
    `https://youtube.com:444/watch?v=${videoId}`,
  ]) {
    assert.throws(() => parseYouTubeVideoUrl(input));
  }
});

test("rejects missing IDs, malformed IDs, and unsupported YouTube paths", () => {
  for (const input of [
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?v=short",
    "https://youtu.be/",
    `https://www.youtube.com/playlist?list=${videoId}`,
    `https://www.youtube.com/channel/${videoId}`,
  ]) {
    assert.throws(() => parseYouTubeVideoUrl(input));
  }
});

test("validates metadata identity and returns the canonical source URL", () => {
  assert.deepEqual(
    validateYouTubeMetadata({ id: videoId, title: " A title " }, videoId),
    { videoId, title: "A title", sourceUrl: canonicalUrl },
  );
});

test("rejects missing or mismatched YouTube metadata", () => {
  assert.throws(() => validateYouTubeMetadata(null, videoId), {
    code: "INVALID_METADATA",
  });
  assert.throws(
    () => validateYouTubeMetadata({ id: "abcdefghijk", title: "Title" }, videoId),
    { code: "VIDEO_ID_MISMATCH" },
  );
  assert.throws(
    () => validateYouTubeMetadata({ id: videoId, title: " " }, videoId),
    { code: "INVALID_METADATA" },
  );
});
