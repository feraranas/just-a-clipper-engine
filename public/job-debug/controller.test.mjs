import test from "node:test";
import assert from "node:assert/strict";
import { createRefreshLoop } from "./controller.mjs";
const flush = () => new Promise((r) => setImmediate(r));
test("only the current job can update the page; stopped requests are ignored", async () => {
  const pending = [],
    seen = [];
  const loop = createRefreshLoop({
    load: (key, signal) =>
      new Promise((resolve) => pending.push({ key, signal, resolve })),
    onData: (x) => seen.push(x),
  });
  loop.start("a");
  loop.start("b");
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve("old");
  pending[1].resolve("new");
  await flush();
  assert.deepEqual(seen, ["new"]);
  loop.stop();
});
test("refresh never overlaps an active request and continues after terminal results", async () => {
  let resolve,
    loads = 0,
    timer;
  const seen = [];
  const loop = createRefreshLoop({
    load: () => {
      loads++;
      return new Promise((r) => (resolve = r));
    },
    onData: (d) => seen.push(d),
    schedule: (fn) => {
      timer = fn;
      return 1;
    },
    cancel: () => {
      timer = null;
    },
  });
  loop.start("a");
  loop.refresh();
  assert.equal(loads, 1);
  resolve({ status: "complete" });
  await flush();
  assert.ok(timer);
  timer();
  assert.equal(loads, 2);
  resolve({ status: "complete" });
  await flush();
  loop.pause();
  assert.equal(timer, null);
  loop.resume();
  assert.equal(loads, 3);
  loop.stop();
});
test("read failures retain prior data, report an error, and retry", async () => {
  let fail = false,
    timer;
  const seen = [],
    errors = [];
  const loop = createRefreshLoop({
    load: async () => {
      if (fail) throw Error("read failed");
      return "snapshot";
    },
    onData: (d) => seen.push(d),
    onError: (e) => errors.push(e.message),
    schedule: (fn) => {
      timer = fn;
      return 1;
    },
    cancel: () => {},
  });
  loop.start("a");
  await flush();
  fail = true;
  timer();
  await flush();
  assert.deepEqual(seen, ["snapshot"]);
  assert.deepEqual(errors, ["read failed"]);
  assert.ok(timer);
  loop.stop();
});
