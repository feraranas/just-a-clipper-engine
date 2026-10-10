import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPublishingLedger } from "./publishing-ledger.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { runPublishingCli } from "./publishing-run.mjs";

const environment = {
  INSTAGRAM_PAGE_ACCESS_TOKEN: "secret-test-token",
  INSTAGRAM_ACCOUNT_ID: "2",
  INSTAGRAM_PAGE_ID: "1",
};
test("CLI without arguments exits nonzero without exposing inherited credentials", () => {
  const result = spawnSync(
    process.execPath,
    [new URL("./publishing-run.mjs", import.meta.url).pathname],
    { encoding: "utf8", env: { ...process.env, ...environment } },
  );
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /secret-test-token/);
});
test("missing live, relative paths, unknown flags and duplicate args never open a ledger or call Meta", async () => {
  for (const argv of [
    [],
    ["--db", "/tmp/x", "--project-root", "/tmp", "--item", "one"],
    ["--live", "--db", "relative", "--project-root", "/tmp", "--item", "one"],
    ["--wat"],
    ["--check-account", "--live"],
    ["--check-account", "--check-account"],
  ]) {
    let touched = false;
    const result = await runPublishingCli(argv, {
      environment,
      output: () => {},
      makeClient: () => {
        touched = true;
        throw new Error("must not run");
      },
      makeLedger: () => {
        touched = true;
      },
    });
    assert.notEqual(result, 0);
    assert.equal(touched, false);
  }
});
test("check-account uses only identity reads and never opens any ledger", async () => {
  const output = [];
  let reads = 0;
  const code = await runPublishingCli(["--check-account"], {
    environment,
    output: (value) => output.push(value),
    makeLedger: () => {
      throw new Error("must not open");
    },
    makeClient: () => ({
      verifyAccount: async (identity) => {
        reads++;
        assert.deepEqual(identity, {
          pageId: "1",
          accountId: "2",
          username: "theballooninquiries",
        });
        return identity;
      },
    }),
  });
  assert.equal(code, 0);
  assert.equal(reads, 1);
  assert.doesNotMatch(JSON.stringify(output), /secret-test-token/);
});
test("raw transport errors are sanitized at the command boundary", async () => {
  const output = [];
  const code = await runPublishingCli(["--check-account"], {
    environment,
    output: (value) => output.push(value),
    makeClient: () => ({
      verifyAccount: async () => {
        throw new Error("secret-test-token");
      },
    }),
  });
  assert.notEqual(code, 0);
  assert.doesNotMatch(JSON.stringify(output), /secret-test-token/);
});

test("publishing CLI uses the shared database default without a duplicate --db option", async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), "publishing-shared-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const dbPath = join(dataRoot, "instagram-publishing.sqlite");
  createPublishingLedger(dbPath).close();
  let opened;
  const code = await runPublishingCli(["--item", "missing", "--live"], {
    environment: { ...environment, AUDIOGRAM_DATA_ROOT: dataRoot },
    output: () => {},
    makeClient: () => ({}),
    makeLedger: (path) => {
      opened = path;
      return createPublishingLedger(path);
    },
  });
  assert.equal(code, 1);
  assert.equal(opened, dbPath);
});
