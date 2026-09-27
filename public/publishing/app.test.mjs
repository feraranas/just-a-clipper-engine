import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPreviewUrl,
  formatItemMetadata,
  mutationRequest,
  normalizeQueuePayload,
} from "./app.mjs";

test("encodes item IDs when building preview URLs", () => {
  assert.equal(buildPreviewUrl("item/one"), "/api/items/item%2Fone/preview");
});

test("normalizes a valid queue payload and rejects malformed payloads", () => {
  assert.deepEqual(normalizeQueuePayload({ items: [{ id: "one" }] }), [
    { id: "one" },
  ]);
  assert.throws(
    () => normalizeQueuePayload({ items: "not-an-array" }),
    /queue payload/i,
  );
});

test("formats metadata without changing item state", () => {
  const item = {
    title: "A clip",
    state: "queued",
    artifactHash: "sha256:abc",
    createdAt: "2026-09-26T12:00:00.000Z",
  };
  assert.deepEqual(formatItemMetadata(item), {
    title: "A clip",
    state: "queued",
    artifactHash: "sha256:abc",
    createdAt: "2026-09-26T12:00:00.000Z",
  });
  assert.equal(item.state, "queued");
});

test("surfaces API error bodies without claiming success", async () => {
  await assert.rejects(
    mutationRequest(
      async () =>
        new Response(JSON.stringify({ error: "stale state" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      "/api/items/one/approve",
      {},
    ),
    /stale state/,
  );
});
