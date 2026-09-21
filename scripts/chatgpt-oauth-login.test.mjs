import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { runDedicatedChatGptLogin } from "./chatgpt-oauth-login.mjs";

const fixture = async (t) => {
  const dir = await fs.mkdtemp("/private/tmp/audiogram-login-test-");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(join(dir, "project"));
  return {
    dir,
    authFile: join(dir, "private", "auth.json"),
    projectRoot: join(dir, "project"),
    now: () => Date.parse("2026-09-20T12:00:00Z"),
  };
};
const upstreamShape = {
  auth_mode: "chatgpt",
  tokens: {
    access_token: "synthetic-access",
    refresh_token: "synthetic-refresh",
    account_id: "synthetic-account",
  },
};
test("login precreates valid JSON securely, suppresses upstream messages, promotes strict credentials", async (t) => {
  const options = await fixture(t);
  const phases = [];
  const result = await runDedicatedChatGptLogin({
    ...options,
    onPhase: (phase) => phases.push(phase),
    login: async (args) => {
      assert.deepEqual(
        JSON.parse(await fs.readFile(args.authFilePath, "utf8")),
        {},
      );
      assert.equal((await fs.stat(args.authFilePath)).mode & 0o777, 0o600);
      assert.equal(
        (await fs.stat(dirname(args.authFilePath))).mode & 0o777,
        0o700,
      );
      args.onMessage(
        `OpenAI OAuth login URL: https://auth.openai.com/oauth/authorize?code=secret`,
      );
      await fs.writeFile(args.authFilePath, JSON.stringify(upstreamShape));
      args.onMessage(
        `Credentials saved to ${args.authFilePath} access_token=secret`,
      );
      return { path: args.authFilePath, secret: "ignored" };
    },
  });
  assert.deepEqual(result, {
    providerId: "chatgpt-oauth",
    status: "authenticated",
  });
  assert.ok(phases.every((phase) => /^oauth_[a-z_]+$/.test(phase)));
  assert.equal((await fs.stat(options.authFile)).mode & 0o777, 0o600);
  const value = JSON.parse(await fs.readFile(options.authFile, "utf8"));
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.last_refresh, "2026-09-20T12:00:00.000Z");
  assert.deepEqual(await fs.readdir(dirname(options.authFile)), ["auth.json"]);
});
test("login replaces existing permissive credentials with a final 0600 file", async (t) => {
  const o = await fixture(t);
  await fs.mkdir(dirname(o.authFile));
  await fs.writeFile(o.authFile, "old", { mode: 0o666 });
  await fs.chmod(o.authFile, 0o666);
  await runDedicatedChatGptLogin({
    ...o,
    login: async ({ authFilePath }) => {
      await fs.writeFile(authFilePath, JSON.stringify(upstreamShape));
      await fs.chmod(authFilePath, 0o666);
    },
  });
  assert.equal((await fs.stat(o.authFile)).mode & 0o777, 0o600);
});
test("exclusive temporary collision fails without invoking login or deleting existing file", async (t) => {
  const o = await fixture(t);
  await fs.mkdir(dirname(o.authFile));
  const temp = join(dirname(o.authFile), ".login-collision.json");
  await fs.writeFile(temp, "untouched");
  await assert.rejects(
    runDedicatedChatGptLogin({
      ...o,
      temporaryId: () => "collision",
      login: () => assert.fail("must not invoke login"),
    }),
    { code: "oauth_login_failed" },
  );
  assert.equal(await fs.readFile(temp, "utf8"), "untouched");
});
for (const phase of ["before", "after"]) {
  test(`detects symlink substitution ${phase} upstream invocation`, async (t) => {
    const o = await fixture(t);
    const target = join(o.dir, "target.json");
    await fs.writeFile(target, "untouched");
    const injected = {
      ...fs,
      async open(path, ...args) {
        const handle = await fs.open(path, ...args);
        if (phase === "before" && String(path).includes(".login-")) {
          const close = handle.close.bind(handle);
          handle.close = async () => {
            await close();
            await fs.unlink(path);
            await fs.symlink(target, path);
          };
        }
        return handle;
      },
    };
    await assert.rejects(
      runDedicatedChatGptLogin({
        ...o,
        fs: injected,
        login: async ({ authFilePath }) => {
          assert.equal(phase, "after");
          await fs.unlink(authFilePath);
          await fs.symlink(target, authFilePath);
        },
      }),
      { code: "oauth_login_temp_changed" },
    );
    assert.equal(await fs.readFile(target, "utf8"), "untouched");
    assert.deepEqual(await fs.readdir(dirname(o.authFile)), []);
  });
}
test("detects regular file inode substitution after upstream write", async (t) => {
  const o = await fixture(t);
  await assert.rejects(
    runDedicatedChatGptLogin({
      ...o,
      login: async ({ authFilePath }) => {
        // Keep the original inode allocated so inode recycling cannot mask substitution.
        await fs.rename(authFilePath, join(o.dir, "original"));
        await fs.writeFile(authFilePath, JSON.stringify(upstreamShape));
      },
    }),
    { code: "oauth_login_temp_changed" },
  );
});
test("detects substitution before permission repair without chmodding the target", async (t) => {
  const o = await fixture(t);
  const target = join(o.dir, "target.json");
  await fs.writeFile(target, "untouched", { mode: 0o666 });
  await fs.chmod(target, 0o666);
  let loginOpens = 0;
  const injected = {
    ...fs,
    async open(path, ...args) {
      if (String(path).includes(".login-")) {
        loginOpens++;
        if (loginOpens === 3) {
          await fs.rename(path, join(o.dir, "original-login-file"));
          await fs.symlink(target, path);
        }
      }
      return fs.open(path, ...args);
    },
  };
  await assert.rejects(
    runDedicatedChatGptLogin({
      ...o,
      fs: injected,
      login: async ({ authFilePath }) => {
        await fs.writeFile(authFilePath, JSON.stringify(upstreamShape));
        await fs.chmod(authFilePath, 0o666);
      },
    }),
    { code: "oauth_login_temp_changed" },
  );
  assert.equal((await fs.stat(target)).mode & 0o777, 0o666);
  assert.equal(await fs.readFile(target, "utf8"), "untouched");
});
test("login failure preserves final credentials and reports no raw error", async (t) => {
  const o = await fixture(t);
  await fs.mkdir(dirname(o.authFile));
  await fs.writeFile(o.authFile, "previous");
  await assert.rejects(
    runDedicatedChatGptLogin({
      ...o,
      login: async () => {
        throw new Error(`secret ${o.authFile}`);
      },
    }),
    (error) =>
      error.code === "oauth_login_failed" &&
      !error.message.includes(o.authFile),
  );
  assert.equal(await fs.readFile(o.authFile, "utf8"), "previous");
  assert.deepEqual(await fs.readdir(dirname(o.authFile)), ["auth.json"]);
});
