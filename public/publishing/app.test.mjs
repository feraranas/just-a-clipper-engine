import assert from "node:assert/strict";
import test from "node:test";

import {
  approveItem,
  buildPreviewUrl,
  formatItemMetadata,
  loadLogs,
  loadQueue,
  mutationRequest,
  normalizeQueuePayload,
  rejectItem,
  saveCaption,
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

test("loads and normalizes queue items from the existing API", async () => {
  const items = await loadQueue(async (url) => {
    assert.equal(url, "/api/items");
    return Response.json({ items: [{ id: "one" }] });
  });
  assert.deepEqual(items, [{ id: "one" }]);
});

test("loads bounded pipeline logs from the local API", async () => {
  const events = await loadLogs(async (url) => {
    assert.equal(url, "/api/logs?limit=50");
    return Response.json({ events: [{ stage: "jev", status: "completed" }] });
  });
  assert.deepEqual(events, [{ stage: "jev", status: "completed" }]);
});

test("approval sends an ISO schedule to the existing approve route", async () => {
  const calls = [];
  await approveItem(async (url, options) => {
    calls.push([url, options]);
    return Response.json({ item: { id: "one", state: "approved" } });
  }, "one", "2026-09-27T12:00:00.000Z");
  assert.equal(calls[0][0], "/api/items/one/approve");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    scheduledAt: "2026-09-27T12:00:00.000Z",
  });
});

test("caption saves and rejection sends their required values", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    return Response.json({ item: { id: "one" } });
  };
  await saveCaption(fetchImpl, "one", "A useful caption");
  await rejectItem(fetchImpl, "one", "Not suitable for this account");
  assert.deepEqual(
    calls.map(([url, options]) => [url, JSON.parse(options.body)]),
    [
      ["/api/items/one/caption", { caption: "A useful caption" }],
      ["/api/items/one/reject", { reason: "Not suitable for this account" }],
    ],
  );
});
