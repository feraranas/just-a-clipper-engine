import test from "node:test";
import assert from "node:assert/strict";
import {
  groupRuns,
  runState,
  describeEvent,
  createLogPoller,
} from "./activity.mjs";

test("groups newest-first API events into chronological run views", () => {
  const events = [
    { runId: "b", stage: "pipeline", status: "completed" },
    { runId: "a", stage: "render", status: "failed" },
    { runId: "b", stage: "pipeline", status: "started" },
  ];
  const groups = groupRuns(events);
  assert.deepEqual(
    groups.map((group) => group.id),
    ["b", "a"],
  );
  assert.deepEqual(
    groups[0].events.map((event) => event.status),
    ["started", "completed"],
  );
  assert.equal(runState(groups[0].events), "completed");
  assert.equal(runState(groups[1].events), "unknown");
  assert.match(
    describeEvent({ stage: "jev", status: "started" }),
    /Evaluate and rank with Jev/,
  );
});

test("missing terminal events never imply completion", () => {
  assert.equal(runState([]), "empty");
  assert.equal(
    runState([
      {
        timestamp: new Date().toISOString(),
        stage: "render",
        status: "completed",
      },
    ]),
    "running",
  );
  assert.equal(
    runState([
      { timestamp: "2020-01-01", stage: "render", status: "completed" },
    ]),
    "unknown",
  );
});

test("polls do not overlap, retain terminal snapshots, and stop scheduling after disposal", async () => {
  let resolve;
  let calls = 0;
  let signal;
  const data = [];
  const timers = new Map();
  let id = 0;
  const poller = createLogPoller({
    load: (value) => {
      signal = value;
      calls++;
      return new Promise((done) => {
        resolve = done;
      });
    },
    onData: (value) => data.push(value),
    onError: assert.fail,
    schedule: (fn, delay) => {
      timers.set(++id, { fn, delay });
      return id;
    },
    cancel: (key) => timers.delete(key),
  });
  const pending = poller.refresh();
  await poller.refresh();
  assert.equal(calls, 1);
  resolve([{ stage: "pipeline", status: "completed" }]);
  await pending;
  assert.equal(data[0][0].status, "completed");
  assert.deepEqual(
    [...timers.values()].map((timer) => timer.delay),
    [2000],
  );
  poller.stop();
  assert.equal(signal.aborted, true);
  assert.equal(timers.size, 0);
  await poller.refresh();
  assert.equal(calls, 1);
});

test("failed refresh schedules a retry", async () => {
  let failures = 0;
  const delays = new Map();
  let id = 0;
  const poller = createLogPoller({
    load: async () => {
      throw Error("offline");
    },
    onData: assert.fail,
    onError: () => failures++,
    schedule: (fn, delay) => {
      delays.set(++id, delay);
      return id;
    },
    cancel: (key) => delays.delete(key),
  });
  await poller.refresh();
  assert.equal(failures, 1);
  assert.deepEqual([...delays.values()], [2000]);
  poller.stop();
});
