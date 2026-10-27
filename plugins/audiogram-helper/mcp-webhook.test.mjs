import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  createWebhookClient,
  createPublicWebhookTransport,
  isPublicAddress,
} from "./mcp-webhook.mjs";
import { buildJobFinishedEvent } from "./mcp-event-contract.mjs";
const secret = `whsec_${Buffer.alloc(32, 2).toString("base64")}`;
const event = buildJobFinishedEvent({
  job: { jobId: "11111111-1111-4111-8111-111111111111" },
  result: { status: "failed", artifacts: [] },
  eventId: "22222222-2222-4222-8222-222222222222",
  sequence: 1,
  timestamp: "2026-10-26T12:00:00Z",
  capture: "unknown",
});

test("public-address policy blocks local, reserved, mapped-private and translation ranges", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "100.64.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "0.0.0.0",
    "192.0.2.1",
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "ff00::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
    "64:ff9b::a00:1",
    "not-ip",
  ])
    assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
    assert.equal(isPublicAddress(ip), true, ip);
});

test("transport pins validated DNS results into the actual connection and resolves again on each send", async () => {
  let resolutions = 0;
  let requests = 0;
  const transport = createPublicWebhookTransport({
    resolveAddresses: async () =>
      ++resolutions === 1
        ? [{ address: "8.8.8.8", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }],
    request: (options, respond) => {
      requests++;
      assert.equal(options.hostname, "receiver.example.com");
      assert.equal(options.servername, "receiver.example.com");
      assert.equal(options.agent, false);
      options.lookup("receiver.example.com", {}, (error, address, family) => {
        assert.equal(error, null);
        assert.equal(address, "8.8.8.8");
        assert.equal(family, 4);
      });
      const request = new EventEmitter();
      request.destroy = (error) => request.emit("error", error);
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = {};
        response.destroy = request.destroy;
        respond(response);
        queueMicrotask(() => response.emit("end"));
      };
      return request;
    },
  });
  assert.equal(
    (
      await transport({
        url: "https://receiver.example.com/callback?private=token",
        body: "{}",
        headers: {},
      })
    ).status,
    200,
  );
  await assert.rejects(
    transport({
      url: "https://receiver.example.com/callback",
      body: "{}",
      headers: {},
    }),
    /unsafe_destination/,
  );
  assert.equal(requests, 1);
});

test("mixed DNS results, unsafe URLs and redirects never become callback data delivery", async () => {
  let calls = 0;
  const transport = createPublicWebhookTransport({
    resolveAddresses: async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "::1", family: 6 },
    ],
    request: () => {
      calls++;
    },
  });
  for (const url of [
    "http://receiver.example.com",
    "https://user:pass@receiver.example.com",
    "https://receiver.example.com/#fragment",
    "https://receiver.example.com/",
  ]) {
    await assert.rejects(transport({ url, body: "{}", headers: {} }));
  }
  assert.equal(calls, 0);
  const client = createWebhookClient({
    transport: async () => ({ status: 302, headers: {}, body: "{}" }),
  });
  const delivery = await client.sendSignedEvent({
    subscription: {
      id: "sub_test",
      url: "https://receiver.example.com",
      secret,
    },
    event,
  });
  assert.equal(delivery.accepted, false);
  assert.equal(delivery.httpStatus, 302);
});

test("signature covers the exact bytes, stable event ID and fresh signing time; rotation signs both keys", async () => {
  const requests = [];
  let now = Date.parse("2026-10-26T12:00:00Z");
  const client = createWebhookClient({
    clock: () => now,
    transport: async (input) => {
      requests.push(input);
      return { status: 200, headers: {}, body: "{}" };
    },
  });
  const subscription = {
    id: "sub_test",
    url: "https://receiver.example.com/callback",
    secret,
    previousSecret: `whsec_${Buffer.alloc(32, 3).toString("base64")}`,
  };
  await client.sendSignedEvent({ subscription, event });
  now += 2000;
  await client.sendSignedEvent({ subscription, event });
  assert.equal(requests[0].headers["webhook-id"], event.eventId);
  assert.equal(requests[0].body, requests[1].body);
  assert.notEqual(
    requests[0].headers["webhook-signature"],
    requests[1].headers["webhook-signature"],
  );
  const input = requests[0];
  const expected = createHmac("sha256", Buffer.alloc(32, 2))
    .update(
      `${event.eventId}.${input.headers["webhook-timestamp"]}.${input.body}`,
    )
    .digest("base64");
  assert.equal(
    input.headers["webhook-signature"].split(" ")[0],
    `v1,${expected}`,
  );
  assert.equal(input.headers["webhook-signature"].split(" ").length, 2);
  assert.equal(input.headers["X-MCP-Subscription-Id"], "sub_test");
});

test("callback verification uses a fresh challenge and fails closed on wrong echo, status and timeout", async () => {
  const challenges = [];
  const client = createWebhookClient({
    transport: async (input) => {
      const body = JSON.parse(input.body);
      challenges.push(body.challenge);
      assert.equal(body.type, "verification");
      assert.match(input.headers["webhook-id"], /^msg_verification_/);
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ challenge: body.challenge }),
      };
    },
  });
  for (let i = 0; i < 2; i++)
    await client.verifyCallback({
      url: "https://receiver.example.com",
      secret,
      subscriptionId: "sub_test",
    });
  assert.notEqual(challenges[0], challenges[1]);
  const wrong = createWebhookClient({
    transport: async () => ({
      status: 200,
      body: '{"challenge":"wrong"}',
      headers: {},
    }),
  });
  await assert.rejects(
    wrong.verifyCallback({
      url: "https://receiver.example.com",
      secret,
      subscriptionId: "sub_test",
    }),
    /challenge_failed/,
  );
  const timeout = createWebhookClient({
    timeoutMs: 5,
    transport: ({ signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  });
  await assert.rejects(
    timeout.verifyCallback({
      url: "https://receiver.example.com",
      secret,
      subscriptionId: "sub_test",
    }),
    /timeout/,
  );
});
