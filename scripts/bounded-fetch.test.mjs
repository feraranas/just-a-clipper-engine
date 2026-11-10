import assert from "node:assert/strict";
import test from "node:test";
import { createBoundedAllowlistedFetch } from "./bounded-fetch.mjs";

const operations = [
  ["https://auth.openai.com/oauth/token", 30_000, "oauth_refresh_timeout"],
  [
    "https://chatgpt.com/backend-api/codex/models?client_version=0.144.1",
    30_000,
    "oauth_catalog_timeout",
  ],
  [
    "https://chatgpt.com/backend-api/codex/responses",
    120_000,
    "oauth_responses_timeout",
  ],
];
const clock = () => {
  const timers = new Map();
  return {
    timers,
    setTimeout(callback, ms) {
      const id = {};
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fire() {
      for (const { callback } of [...timers.values()]) callback();
    },
  };
};
test("configured Responses deadline is bounded and does not change other operations", async () => {
  const scheduler = clock();
  const fetch = createBoundedAllowlistedFetch({
    scheduler,
    responsesTimeoutMs: 300000,
    fetch: async () => new Promise(() => {}),
  });
  const pending = fetch("https://chatgpt.com/backend-api/codex/responses");
  assert.equal([...scheduler.timers.values()][0].ms, 300000);
  scheduler.fire();
  await assert.rejects(pending, { code: "oauth_responses_timeout" });
  assert.throws(
    () => createBoundedAllowlistedFetch({ responsesTimeoutMs: 600001 }),
    /timeout/,
  );
});
for (const [url, milliseconds, code] of operations) {
  test(`${code} bounds headers even when fetch ignores abort`, async () => {
    const scheduler = clock();
    let signal;
    const fetch = createBoundedAllowlistedFetch({
      scheduler,
      fetch: async (_, init) => {
        signal = init.signal;
        return new Promise(() => {});
      },
    });
    const pending = fetch(url);
    assert.equal([...scheduler.timers.values()][0].ms, milliseconds);
    scheduler.fire();
    await assert.rejects(pending, { code });
    assert.equal(signal.aborted, true);
    assert.equal(scheduler.timers.size, 0);
  });
  test(`${code} remains armed after headers and cancels a stalled body`, async () => {
    const scheduler = clock();
    let cancelled = false;
    const fetch = createBoundedAllowlistedFetch({
      scheduler,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    const response = await fetch(url);
    const pending = response.text();
    assert.equal(scheduler.timers.size, 1);
    scheduler.fire();
    await assert.rejects(pending, { code });
    assert.equal(cancelled, true);
    assert.equal(scheduler.timers.size, 0);
  });
}
test("rejects nonallowlisted origins, userinfo, ports, paths and redirects", async () => {
  let calls = 0;
  const makeFetch = () =>
    createBoundedAllowlistedFetch({
      fetch: async (_, init) => {
        calls++;
        assert.equal(init.redirect, "error");
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.invalid" },
        });
      },
    });
  for (const url of [
    "http://auth.openai.com/oauth/token",
    "https://auth.openai.com:444/oauth/token",
    "https://user:pass@auth.openai.com/oauth/token",
    "https://auth.openai.com.evil/oauth/token",
    "https://chatgpt.com/backend-api/codex/images",
    "https://registry.npmjs.org/@openai/codex/latest",
  ])
    await assert.rejects(makeFetch()(url), { code: "oauth_url_forbidden" });
  assert.equal(calls, 0);
  await assert.rejects(makeFetch()(operations[0][0]), {
    code: "oauth_redirect_forbidden",
  });
  assert.equal(calls, 1);
});
test("rejects a fetch implementation that already followed a redirect", async () => {
  const response = new Response("secret");
  Object.defineProperties(response, {
    redirected: { value: true },
    url: { value: "https://attacker.invalid" },
  });
  const fetch = createBoundedAllowlistedFetch({ fetch: async () => response });
  await assert.rejects(fetch(operations[0][0]), {
    code: "oauth_redirect_forbidden",
  });
});
test("caps each endpoint at its configured response limit", async () => {
  for (const [url] of operations) {
    const limit = url.pathname === "/oauth/token" ? 262_144 : 2 * 1024 * 1024;
    let cancelled = false;
    const fetch = createBoundedAllowlistedFetch({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(limit));
              c.enqueue(new Uint8Array(1));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    await assert.rejects((await fetch(url)).arrayBuffer(), {
      code: "oauth_response_too_large",
    });
    assert.equal(cancelled, true);
  }
});
test("EOF and explicit cancel release timers; caller abort cancels readers", async () => {
  const scheduler = clock();
  const fetch = createBoundedAllowlistedFetch({
    scheduler,
    fetch: async () => new Response("ok"),
  });
  assert.equal(await (await fetch(operations[0][0])).text(), "ok");
  assert.equal(scheduler.timers.size, 0);
  const controller = new AbortController();
  const stalled = createBoundedAllowlistedFetch({
    scheduler,
    fetch: async () => new Response(new ReadableStream()),
  });
  const response = await stalled(operations[2][0], {
    signal: controller.signal,
  });
  const pending = response.text();
  controller.abort(new Error("secret caller reason"));
  await assert.rejects(pending, { code: "oauth_request_aborted" });
  assert.equal(scheduler.timers.size, 0);
  const another = createBoundedAllowlistedFetch({
    scheduler,
    fetch: async () => new Response(new ReadableStream()),
  });
  await (await another(operations[2][0])).body.cancel();
  assert.equal(scheduler.timers.size, 0);
});
