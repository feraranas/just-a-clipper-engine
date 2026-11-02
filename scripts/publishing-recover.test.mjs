import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runRecoveryCli } from "./publishing-recover.mjs";
import { acquireWorkerLock } from "./publishing-execution.mjs";
import { runPublishingOnce } from "./publishing-worker.mjs";
import { recoveryFixture } from "./test-support/recovery-fixture.mjs";

const environment = {
  INSTAGRAM_PAGE_ACCESS_TOKEN: "fixture-secret",
  INSTAGRAM_ACCOUNT_ID: "2",
  INSTAGRAM_PAGE_ID: "1",
};
const invoke = async (f, extra = [], dependencies = {}) => {
  const output = [];
  const code = await runRecoveryCli(
    ["--db", f.path, "--project-root", f.root, "--item", f.itemId, ...extra],
    {
      environment,
      makeClient: () => f.client,
      output: (v) => output.push(v),
      ...dependencies,
    },
  );
  assert.ok(!JSON.stringify(output).includes("fixture-secret"));
  return { code, output };
};
const apply = (f) => [
  "--apply",
  "--expected-attempt",
  f.attemptId,
  "--expected-container",
  "123",
];
for (const extra of [
  ["--bogus"],
  ["--item", "duplicate"],
  ["--apply"],
  ["--apply", "--expected-attempt", "x"],
  ["--db", "relative"],
  ["--expected-container", "123"],
  ["--apply", "true"],
])
  test(`reject malformed options ${extra.join(" ")}`, async (t) => {
    const f = await recoveryFixture(t);
    assert.equal((await invoke(f, extra)).code, 1);
  });
test("default inspection is read-only, no lock or schema initialization", async (t) => {
  const f = await recoveryFixture(t),
    db = new DatabaseSync(f.path);
  db.exec("DROP TABLE publishing_recoveries");
  db.close();
  const before = f.ledger.getPublishingItem(f.itemId);
  const r = await invoke(f, [], {
    acquireLock: () => {
      throw new Error("must not lock");
    },
  });
  assert.equal(r.code, 0);
  assert.equal(r.output[0].eligible, true);
  assert.deepEqual(f.ledger.getPublishingItem(f.itemId), before);
  const check = new DatabaseSync(f.path, { readOnly: true });
  assert.equal(
    check
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='publishing_recoveries'",
      )
      .get(),
    undefined,
  );
  check.close();
});
test("lock contention and ownership loss prevent apply", async (t) => {
  const f = await recoveryFixture(t);
  const lock = await acquireWorkerLock(f.path);
  assert.equal((await invoke(f, apply(f))).code, 1);
  await lock.release();
  let released = false;
  assert.equal(
    (
      await invoke(f, apply(f), {
        acquireLock: async () => ({
          assertOwned: async () => {
            throw new Error("lost");
          },
          release: async () => {
            released = true;
          },
        }),
      })
    ).code,
    1,
  );
  assert.equal(released, true);
  assert.equal(f.ledger.getPublishingItem(f.itemId).state, "container_created");
});
test("stale explicit identifiers and provider failures block without requeue", async (t) => {
  const f = await recoveryFixture(t);
  assert.equal(
    (
      await invoke(f, [
        "--apply",
        "--expected-attempt",
        "other",
        "--expected-container",
        "123",
      ])
    ).code,
    1,
  );
  f.client.getContainerStatus = async () => {
    throw new Error("secret provider message");
  };
  const r = await invoke(f, apply(f));
  assert.equal(r.code, 1);
  assert.ok(!JSON.stringify(r.output).includes("secret"));
  assert.equal(f.ledger.getPublishingItem(f.itemId).state, "container_created");
});
test("recover -> queued worker no-op -> fresh approval -> new container publishes once", async (t) => {
  const f = await recoveryFixture(t);
  assert.equal((await invoke(f, apply(f))).code, 0);
  assert.equal((await invoke(f, apply(f))).code, 1);
  const lock = await acquireWorkerLock(f.path);
  try {
    const args = {
      ...f,
      lock,
      now: () => "2026-10-13T00:00:00Z",
      sleep: async () => {},
    };
    assert.equal((await runPublishingOnce(args)).status, "queued");
    f.ledger.approveItem(f.itemId, "2026-10-03T00:00:00Z");
    const calls = [];
    f.client.createContainer = async () => {
      calls.push("create");
      return {
        id: "456",
        uri: "https://rupload.facebook.com/ig-api-upload/v26.0/456",
      };
    };
    f.client.uploadVideo = async ({ uri }) => {
      assert.ok(uri.endsWith("/456"));
      calls.push("upload");
    };
    f.client.getContainerStatus = async (id) => {
      assert.equal(id, "456");
      return {
        statusCode: "FINISHED",
        uploadPhase: "complete",
        processingPhase: "complete",
      };
    };
    f.client.publishContainer = async ({ containerId }) => {
      assert.equal(containerId, "456");
      calls.push("publish");
      return { id: "789" };
    };
    assert.equal((await runPublishingOnce(args)).status, "published");
    await runPublishingOnce(args);
    assert.deepEqual(calls, ["create", "upload", "publish"]);
    const db = new DatabaseSync(f.path, { readOnly: true });
    const old = db
      .prepare("SELECT * FROM publishing_attempts WHERE id=?")
      .get(f.attemptId);
    assert.equal(old.container_id, "123");
    assert.equal(old.phase, "failed");
    db.close();
  } finally {
    await lock.release();
  }
});
