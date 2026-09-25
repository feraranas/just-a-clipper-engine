import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadFreshChatGptSession,
  writeCredentialsAtomically,
  normalizeLoginCredentials,
  resolveChatGptAuthFile,
} from "./chatgpt-oauth-credentials.mjs";

const now = () => Date.parse("2026-09-20T12:00:00.000Z");
const jwt = (claims) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic`;
const valid = (extra = {}) => ({
  schemaVersion: 1,
  auth_mode: "chatgpt",
  tokens: {
    access_token: "synthetic-access",
    refresh_token: "synthetic-refresh",
    account_id: "synthetic-account",
  },
  last_refresh: "2026-09-20T12:00:00.000Z",
  access_expires_at: null,
  is_fedramp: false,
  ...extra,
});
const fixture = async (t) => {
  const dir = await fs.mkdtemp(
    join(await fs.realpath(tmpdir()), "audiogram-credentials-test-"),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(join(dir, "project"));
  return {
    dir,
    authFile: join(dir, "private", "auth.json"),
    projectRoot: join(dir, "project"),
    now,
  };
};
const put = async (options, value) => {
  await fs.mkdir(join(options.dir, "private"), { recursive: true });
  await fs.writeFile(options.authFile, JSON.stringify(value));
};
test("default path is app-owned and runtime override is explicit", () => {
  assert.equal(
    resolveChatGptAuthFile({
      homeDirectory: "/Users/synthetic-user",
      environment: { CODEX_HOME: "/ignore", HOME: "/ignore" },
    }),
    "/Users/synthetic-user/Library/Application Support/Audiogram Inbox/chatgpt-oauth/auth.json",
  );
  assert.equal(
    resolveChatGptAuthFile({
      environment: { AUDIOGRAM_CHATGPT_AUTH_PATH: "/synthetic/auth.json" },
    }),
    "/synthetic/auth.json",
  );
});
test("atomic first save repairs permissions and exposes only the minimal session", async (t) => {
  const options = await fixture(t);
  await writeCredentialsAtomically(valid(), options);
  await fs.chmod(options.authFile, 0o666);
  await fs.chmod(join(options.dir, "private"), 0o777);
  assert.deepEqual(await loadFreshChatGptSession(options), {
    accessToken: "synthetic-access",
    accountId: "synthetic-account",
    isFedRamp: false,
  });
  assert.equal((await fs.stat(options.authFile)).mode & 0o777, 0o600);
  assert.equal(
    (await fs.stat(join(options.dir, "private"))).mode & 0o777,
    0o700,
  );
});
test("a parent fsync failure reports lost durability after publishing valid new JSON", async (t) => {
  const o = await fixture(t);
  await writeCredentialsAtomically(valid(), o);
  const changed = valid({ last_refresh: "2026-09-20T12:01:00.000Z" });
  const parent = join(o.dir, "private");
  const injected = {
    ...fs,
    async open(path, ...args) {
      const handle = await fs.open(path, ...args);
      if (path === parent)
        handle.sync = async () => {
          throw new Error("secret directory sync");
        };
      return handle;
    },
  };
  await assert.rejects(
    writeCredentialsAtomically(changed, { ...o, fs: injected }),
    { code: "oauth_credentials_write_failed" },
  );
  assert.deepEqual(JSON.parse(await fs.readFile(o.authFile, "utf8")), changed);
  assert.deepEqual(await fs.readdir(parent), ["auth.json"]);
});
test("rejects relative, project, symlink parents and symlink final paths", async (t) => {
  const o = await fixture(t);
  for (const authFile of ["relative.json", join(o.projectRoot, "auth.json")])
    await assert.rejects(
      writeCredentialsAtomically(valid(), { ...o, authFile }),
      { code: "oauth_credentials_path_invalid" },
    );
  await fs.mkdir(join(o.dir, "target"));
  await fs.symlink(join(o.dir, "target"), join(o.dir, "private"));
  await assert.rejects(writeCredentialsAtomically(valid(), o), {
    code: "oauth_credentials_path_invalid",
  });
  await fs.unlink(join(o.dir, "private"));
  await fs.mkdir(join(o.dir, "private"));
  const target = join(o.dir, "target", "auth.json");
  await fs.writeFile(target, "original");
  await fs.symlink(target, o.authFile);
  await assert.rejects(writeCredentialsAtomically(valid(), o), {
    code: "oauth_credentials_path_invalid",
  });
  assert.equal(await fs.readFile(target, "utf8"), "original");
});
for (const stage of ["write", "sync", "rename"]) {
  test(`atomic ${stage} failure preserves previous JSON and removes own temp`, async (t) => {
    const o = await fixture(t);
    await writeCredentialsAtomically(valid(), o);
    const injected = {
      ...fs,
      async open(path, ...args) {
        const handle = await fs.open(path, ...args);
        if (String(path).includes(".tmp-")) {
          if (stage === "write")
            handle.writeFile = async () => {
              throw new Error("secret write");
            };
          if (stage === "sync")
            handle.sync = async () => {
              throw new Error("secret sync");
            };
        }
        return handle;
      },
      async rename(...args) {
        if (stage === "rename") throw new Error("secret rename");
        return fs.rename(...args);
      },
    };
    await assert.rejects(
      writeCredentialsAtomically(
        valid({ last_refresh: "2026-09-20T12:01:00.000Z" }),
        { ...o, fs: injected },
      ),
      { code: "oauth_credentials_write_failed" },
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(o.authFile, "utf8")),
      valid(),
    );
    assert.deepEqual(await fs.readdir(join(o.dir, "private")), ["auth.json"]);
  });
}
test("strict credentials reject unknown keys, invalid dates, missing bounds and conflicting claims", async (t) => {
  const o = await fixture(t);
  const cases = [
    valid({ extra: "secret" }),
    valid({ last_refresh: undefined }),
    valid({ last_refresh: "2026-02-30T12:00:00Z" }),
    valid({ last_refresh: 4 }),
    valid({ access_expires_at: "garbage" }),
    valid({ schemaVersion: 2 }),
    valid({ is_fedramp: "false" }),
    valid({ tokens: { ...valid().tokens, access_token: "" } }),
    valid({ tokens: { ...valid().tokens, access_token: "x".repeat(16385) } }),
    valid({ tokens: { ...valid().tokens, account_id: "x".repeat(513) } }),
    valid({ tokens: { ...valid().tokens, unexpected: true } }),
    valid({
      tokens: {
        ...valid().tokens,
        access_token: jwt({ chatgpt_account_id: "different" }),
      },
    }),
  ];
  for (const value of cases) {
    await put(o, value);
    await assert.rejects(loadFreshChatGptSession(o), {
      code: "oauth_credentials_invalid",
    });
  }
});
test("normalization derives expiry/account/routing but never treats malformed JWT expiry as authorization", () => {
  const token = jwt({
    exp: 1790000000,
    chatgpt_account_id: "synthetic-account",
    "https://api.openai.com/auth": { chatgpt_account_is_fedramp: true },
  });
  const normalized = normalizeLoginCredentials(
    { auth_mode: "chatgpt", tokens: { access_token: token } },
    { now },
  );
  assert.equal(normalized.last_refresh, "2026-09-20T12:00:00.000Z");
  assert.equal(normalized.access_expires_at, "2026-09-21T14:13:20.000Z");
  assert.equal(normalized.tokens.account_id, "synthetic-account");
  assert.equal(normalized.is_fedramp, true);
  for (const exp of [undefined, "tomorrow", 1e100]) {
    const result = normalizeLoginCredentials(
      {
        auth_mode: "chatgpt",
        tokens: {
          access_token: jwt({ exp, chatgpt_account_id: "synthetic-account" }),
        },
      },
      { now },
    );
    assert.equal(result.access_expires_at, null);
  }
});
for (const stale of [
  { last_refresh: "2026-09-20T11:05:00.000Z" },
  { access_expires_at: "2026-09-20T12:05:00.000Z" },
]) {
  test(`serializes refresh, retains omitted tokens, saves once: ${JSON.stringify(stale)}`, async (t) => {
    const o = await fixture(t);
    const idToken = jwt({ chatgpt_account_id: "synthetic-account" });
    await writeCredentialsAtomically(
      valid({ ...stale, tokens: { ...valid().tokens, id_token: idToken } }),
      o,
    );
    let calls = 0;
    const fetch = async (url, init) => {
      calls++;
      assert.equal(String(url), "https://auth.openai.com/oauth/token");
      assert.equal(JSON.parse(init.body).refresh_token, "synthetic-refresh");
      return Response.json({
        access_token: jwt({
          exp: now() / 1000 + 3600,
          chatgpt_account_id: "synthetic-account",
        }),
      });
    };
    const sessions = await Promise.all([
      loadFreshChatGptSession({ ...o, fetch }),
      loadFreshChatGptSession({ ...o, fetch }),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(sessions[0], sessions[1]);
    const saved = JSON.parse(await fs.readFile(o.authFile, "utf8"));
    assert.equal(saved.tokens.refresh_token, "synthetic-refresh");
    assert.equal(saved.tokens.id_token, idToken);
    assert.equal(saved.last_refresh, "2026-09-20T12:00:00.000Z");
  });
}
test("stale unrefreshable credentials fail safely without network or token disclosure", async (t) => {
  const o = await fixture(t);
  await put(
    o,
    valid({
      last_refresh: "2026-09-20T11:00:00.000Z",
      tokens: { access_token: "secret", account_id: "synthetic-account" },
    }),
  );
  await assert.rejects(
    loadFreshChatGptSession({
      ...o,
      fetch: () => assert.fail("network must not run"),
    }),
    { code: "oauth_credentials_unrefreshable" },
  );
});
test("invalid returned optional token is rejected without replacing previous credentials", async (t) => {
  const o = await fixture(t);
  const prior = valid({ last_refresh: "2026-09-20T11:00:00.000Z" });
  await put(o, prior);
  for (const refresh_token of ["", 42, null]) {
    await assert.rejects(
      loadFreshChatGptSession({
        ...o,
        fetch: async () =>
          Response.json({ access_token: "new-access", refresh_token }),
      }),
      { code: "oauth_credentials_invalid" },
    );
    assert.deepEqual(JSON.parse(await fs.readFile(o.authFile, "utf8")), prior);
  }
});
