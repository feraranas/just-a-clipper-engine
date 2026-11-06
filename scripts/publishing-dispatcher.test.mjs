import test from "node:test";
import assert from "node:assert/strict";
import { dispatchPass, runDispatcher, runDispatcherCli } from "./publishing-dispatcher.mjs";

const now = "2026-11-06T12:00:00.000Z";
const item = (id, changes = {}) => ({ id, state: "approved", accountId: "2", scheduledAt: now, ...changes });

test("dispatches only due approved or active items for the configured account once per pass", async () => {
  const items = [item("due"), item("pending", {state:"processing"}), item("future", {scheduledAt:"2026-11-07T12:00:00.000Z"}), item("other", {accountId:"3"}), item("failed", {state:"failed"})];
  const seen = [];
  await dispatchPass({list: () => items, accountId:"2", now: () => now, run: async id => { seen.push(id); return {status:"pending"}; }});
  assert.deepEqual(seen, ["due", "pending"]);
});

test("one worker failure does not block later items or leak exception messages", async () => {
  const seen = [], output = [];
  await dispatchPass({list: () => [item("a"), item("b")], accountId:"2", now: () => now, output: x => output.push(x), run: async id => {seen.push(id); if(id === "a") throw new Error("secret"); return {status:"published"};}});
  assert.deepEqual(seen, ["a", "b"]);
  assert.doesNotMatch(JSON.stringify(output), /secret/);
});

test("waits between passes and stops without starting another after shutdown", async () => {
  const controller = new AbortController();
  let passes = 0, waits = 0;
  await runDispatcher({signal:controller.signal, pass:async () => {passes++;}, wait:async () => {waits++; controller.abort();}});
  assert.equal(passes, 1);
  assert.equal(waits, 1);
});

test("does not allow invalid scheduled dates", async () => {
  const seen = [];
  await dispatchPass({list:() => [item("bad", {scheduledAt:"bad"})], accountId:"2", now:() => now, run:async id => seen.push(id)});
  assert.deepEqual(seen, []);
});

test("requires explicit live flag before opening any database or resolving credentials", async () => {
  const messages = [];
  assert.equal(await runDispatcherCli([], {environment:{}, output:x => messages.push(x)}), 1);
  assert.equal(messages[0].errorCode, "DISPATCH_LIVE_FLAG_REQUIRED");
});

test("shutdown during an item prevents remaining items from starting", async () => {
  const controller = new AbortController(), seen = [];
  await dispatchPass({list:() => [item("one"), item("two")], accountId:"2", now:() => now, signal:controller.signal, run:async id => {seen.push(id); controller.abort(); return {status:"pending"};}});
  assert.deepEqual(seen, ["one"]);
});
