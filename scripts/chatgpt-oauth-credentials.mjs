import * as nodeFs from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  deriveAccountId,
  deriveChatGptAccountIsFedRamp,
  parseJwtClaims,
  refreshOpenAIOAuthTokens,
} from "@openai-oauth/core";
import { createBoundedAllowlistedFetch } from "./bounded-fetch.mjs";
import { SafeDiagnosticError } from "./error-diagnostics.mjs";

const failure = (code) =>
  new SafeDiagnosticError({ providerId: "chatgpt-oauth", code });
const invalid = () => {
  throw failure("oauth_credentials_invalid");
};
const exact = (value, keys) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    invalid();
};
const string = (value, maximum) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value, "utf8") > maximum
  )
    invalid();
  return value;
};
const instant = (value) => {
  if (typeof value !== "string") invalid();
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match || !Number.isFinite(Date.parse(value))) invalid();
  const [, year, month, day, hour, minute, second] = match;
  if (
    +month < 1 ||
    +month > 12 ||
    +day < 1 ||
    +day > new Date(Date.UTC(+year, +month, 0)).getUTCDate() ||
    +hour > 23 ||
    +minute > 59 ||
    +second > 59
  )
    invalid();
  return value;
};
const routing = (tokens) => {
  const ids = [
    deriveAccountId(tokens.access_token),
    deriveAccountId(tokens.id_token),
    tokens.account_id,
  ].filter((value) => value !== undefined);
  if (ids.length === 0 || ids.some((value) => value !== ids[0])) invalid();
  return {
    accountId: string(ids[0], 512),
    isFedRamp:
      deriveChatGptAccountIsFedRamp(tokens.access_token) ||
      deriveChatGptAccountIsFedRamp(tokens.id_token),
  };
};
const expiry = (token) => {
  const exp = parseJwtClaims(token)?.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  const date = new Date(exp * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
export const validateChatGptCredentials = (value) => {
  exact(value, [
    "schemaVersion",
    "auth_mode",
    "tokens",
    "last_refresh",
    "access_expires_at",
    "is_fedramp",
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.auth_mode !== "chatgpt" ||
    typeof value.is_fedramp !== "boolean"
  )
    invalid();
  exact(value.tokens, [
    "access_token",
    "id_token",
    "refresh_token",
    "account_id",
  ]);
  string(value.tokens.access_token, 16384);
  string(value.tokens.account_id, 512);
  for (const key of ["id_token", "refresh_token"])
    if (Object.hasOwn(value.tokens, key)) string(value.tokens[key], 16384);
  instant(value.last_refresh);
  if (value.access_expires_at !== null) instant(value.access_expires_at);
  const metadata = routing(value.tokens);
  if (metadata.isFedRamp !== value.is_fedramp) invalid();
  return value;
};
export const normalizeLoginCredentials = (value, { now = Date.now } = {}) => {
  exact(value, ["auth_mode", "tokens", "last_refresh"]);
  if (value.auth_mode !== "chatgpt") invalid();
  exact(value.tokens, [
    "access_token",
    "id_token",
    "refresh_token",
    "account_id",
  ]);
  // Validate size before any JWT decoding.
  string(value.tokens.access_token, 16384);
  for (const key of ["id_token", "refresh_token"])
    if (Object.hasOwn(value.tokens, key)) string(value.tokens[key], 16384);
  const metadata = routing(value.tokens);
  return validateChatGptCredentials({
    schemaVersion: 1,
    auth_mode: "chatgpt",
    tokens: { ...value.tokens, account_id: metadata.accountId },
    last_refresh:
      value.last_refresh === undefined
        ? new Date(now()).toISOString()
        : value.last_refresh,
    access_expires_at: expiry(value.tokens.access_token),
    is_fedramp: metadata.isFedRamp,
  });
};

export const resolveChatGptAuthFile = ({
  environment = process.env,
  homeDirectory = homedir(),
} = {}) =>
  environment.AUDIOGRAM_CHATGPT_AUTH_PATH ??
  join(
    homeDirectory,
    "Library",
    "Application Support",
    "Audiogram Inbox",
    "chatgpt-oauth",
    "auth.json",
  );

// Serialize login/load/refresh inside this process. Cross-process leasing is PR6.
let lock = Promise.resolve();
export const withChatGptCredentialLock = (operation) => {
  const result = lock.then(operation);
  lock = result.catch(() => {});
  return result;
};
const containedBy = (path, root) => {
  const rel = relative(root, path);
  return (
    rel === "" || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel))
  );
};
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const regular = (stat) =>
  stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1;

// Validate every existing ancestor before mkdir; realpath also rejects ancestor
// aliases. O_NOFOLLOW and inode checks protect the file operations themselves.
export const verifyCredentialLocation = async ({
  authFile = resolveChatGptAuthFile(),
  projectRoot = process.cwd(),
  fs = nodeFs,
  allowMissing = true,
} = {}) => {
  try {
    if (
      typeof authFile !== "string" ||
      !isAbsolute(authFile) ||
      authFile !== resolve(authFile)
    )
      throw failure("oauth_credentials_path_invalid");
    const root = await fs.realpath(projectRoot);
    if (containedBy(authFile, root))
      throw failure("oauth_credentials_path_invalid");
    const parent = dirname(authFile);
    if (parent === "/") throw failure("oauth_credentials_path_invalid");
    let ancestor = parent;
    while (true) {
      try {
        const stat = await fs.lstat(ancestor);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          (await fs.realpath(ancestor)) !== ancestor
        )
          throw failure("oauth_credentials_path_invalid");
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        ancestor = dirname(ancestor);
      }
    }
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const before = await fs.lstat(parent);
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      (await fs.realpath(parent)) !== parent ||
      containedBy(parent, root)
    )
      throw failure("oauth_credentials_path_invalid");
    await fs.chmod(parent, 0o700);
    const after = await fs.lstat(parent);
    if (!sameFile(before, after) || (after.mode & 0o777) !== 0o700)
      throw failure("oauth_credentials_path_invalid");
    let finalStat;
    try {
      finalStat = await fs.lstat(authFile);
    } catch (error) {
      if (error.code !== "ENOENT" || !allowMissing) throw error;
    }
    if (finalStat) {
      if (!regular(finalStat)) throw failure("oauth_credentials_path_invalid");
      const handle = await fs.open(
        authFile,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        if (!sameFile(finalStat, await handle.stat()))
          throw failure("oauth_credentials_path_invalid");
        await handle.chmod(0o600);
        const stat = await handle.stat();
        if (
          !regular(stat) ||
          (stat.mode & 0o777) !== 0o600 ||
          !sameFile(stat, await fs.lstat(authFile))
        )
          throw failure("oauth_credentials_path_invalid");
      } finally {
        await handle.close();
      }
    }
    return { authFile, parent };
  } catch (error) {
    if (error instanceof SafeDiagnosticError) throw error;
    if (error.code === "ENOENT") throw failure("oauth_credentials_missing");
    throw failure("oauth_credentials_path_invalid");
  }
};

export const readCredentialJson = async (path, { fs = nodeFs } = {}) => {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !regular(stat) ||
      stat.size > 65536 ||
      !sameFile(stat, await fs.lstat(path))
    )
      invalid();
    // The extra byte also bounds a file that grows after stat.
    const bytes = Buffer.alloc(65537);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        size,
        bytes.length - size,
        null,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > 65536) invalid();
    try {
      return JSON.parse(bytes.subarray(0, size).toString("utf8"));
    } catch {
      invalid();
    }
  } finally {
    await handle.close();
  }
};

export const writeCredentialsAtomically = async (credentials, options = {}) => {
  validateChatGptCredentials(credentials);
  const fs = options.fs ?? nodeFs;
  const { authFile, parent } = await verifyCredentialLocation(options);
  const temp = join(parent, `.auth.tmp-${randomUUID()}`);
  let handle,
    ownsTemp = false;
  try {
    handle = await fs.open(temp, "wx", 0o600);
    ownsTemp = true;
    await handle.writeFile(`${JSON.stringify(credentials)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await verifyCredentialLocation(options);
    await fs.rename(temp, authFile);
    ownsTemp = false;
    const directory = await fs.open(
      parent,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await verifyCredentialLocation({ ...options, allowMissing: false });
  } catch (error) {
    if (error instanceof SafeDiagnosticError) throw error;
    throw failure("oauth_credentials_write_failed");
  } finally {
    await handle?.close().catch(() => {});
    if (ownsTemp) await fs.unlink(temp).catch(() => {});
  }
};

export const loadFreshChatGptSession = (options = {}) =>
  withChatGptCredentialLock(async () => {
    try {
      const { authFile } = await verifyCredentialLocation({
        ...options,
        allowMissing: false,
      });
      let value = validateChatGptCredentials(
        await readCredentialJson(authFile, options),
      );
      const now = options.now ?? Date.now;
      const time = now();
      if (
        (value.access_expires_at !== null &&
          Date.parse(value.access_expires_at) <= time + 300_000) ||
        Date.parse(value.last_refresh) <= time - 3_300_000
      ) {
        if (!value.tokens.refresh_token)
          throw failure("oauth_credentials_unrefreshable");
        let boundedError;
        const fetch = createBoundedAllowlistedFetch({
          fetch: options.fetch,
          scheduler: options.scheduler,
          signal: options.signal,
          onError: (error) => {
            boundedError = error;
          },
        });
        let refreshed;
        try {
          refreshed = await refreshOpenAIOAuthTokens({
            refreshToken: value.tokens.refresh_token,
            fetch,
            signal: options.signal,
          });
        } catch {
          throw boundedError ?? failure("oauth_refresh_failed");
        }
        const tokens = { ...value.tokens, access_token: refreshed.accessToken };
        for (const key of ["refresh_token", "id_token"]) {
          if (Object.hasOwn(refreshed.raw, key))
            tokens[key] = string(refreshed.raw[key], 16384);
        }
        value = normalizeLoginCredentials(
          {
            auth_mode: "chatgpt",
            tokens,
            last_refresh: new Date(time).toISOString(),
          },
          { now },
        );
        await writeCredentialsAtomically(value, options);
      }
      return {
        accessToken: value.tokens.access_token,
        accountId: value.tokens.account_id,
        isFedRamp: value.is_fedramp,
      };
    } catch (error) {
      if (error instanceof SafeDiagnosticError) throw error;
      throw failure("oauth_credentials_invalid");
    }
  });
