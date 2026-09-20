import * as nodeFs from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runOpenAIOAuthLogin } from "openai-oauth";
import { createBoundedAllowlistedFetch } from "./bounded-fetch.mjs";
import {
  normalizeLoginCredentials,
  readCredentialJson,
  resolveChatGptAuthFile,
  verifyCredentialLocation,
  withChatGptCredentialLock,
  writeCredentialsAtomically,
} from "./chatgpt-oauth-credentials.mjs";
import {
  SafeDiagnosticError,
  sanitizeErrorDiagnostic,
} from "./error-diagnostics.mjs";

const failure = (code) =>
  new SafeDiagnosticError({ providerId: "chatgpt-oauth", code });
export const runDedicatedChatGptLogin = (options = {}) =>
  withChatGptCredentialLock(async () => {
    const fs = options.fs ?? nodeFs;
    const login = options.login ?? runOpenAIOAuthLogin;
    const onPhase = options.onPhase ?? (() => {});
    const settings = {
      ...options,
      authFile:
        options.authFile ??
        resolveChatGptAuthFile({ environment: options.environment }),
    };
    let temp,
      handle,
      ownsTemp = false,
      boundedError;
    try {
      const { parent } = await verifyCredentialLocation(settings);
      const id = (options.temporaryId ?? randomUUID)();
      if (!/^[A-Za-z0-9-]+$/.test(id)) throw failure("oauth_login_failed");
      temp = join(parent, `.login-${id}.json`);
      handle = await fs.open(temp, "wx", 0o600);
      ownsTemp = true;
      // Upstream saveAuthTokens parses the existing file before updating it.
      await handle.writeFile("{}\n", "utf8");
      await handle.sync();
      const original = await handle.stat();
      await handle.close();
      handle = undefined;
      const verifyTemp = async () => {
        const stat = await fs.lstat(temp);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.dev !== original.dev ||
          stat.ino !== original.ino
        )
          throw failure("oauth_login_temp_changed");
      };
      await verifyTemp();
      const fetch = createBoundedAllowlistedFetch({
        fetch: options.fetch,
        scheduler: options.scheduler,
        signal: options.signal,
        onError: (error) => {
          boundedError = error;
        },
      });
      onPhase("oauth_login_started");
      await login({
        authFilePath: temp,
        fetch,
        signal: options.signal,
        timeoutMs: 300_000,
        onMessage: () => onPhase("oauth_login_progress"),
      });
      if (boundedError) throw boundedError;
      await verifyTemp();
      const credentials = normalizeLoginCredentials(
        await readCredentialJson(temp, { fs }),
        { now: options.now },
      );
      await verifyTemp();
      let permissionHandle;
      try {
        permissionHandle = await fs.open(
          temp,
          constants.O_RDWR | constants.O_NOFOLLOW,
        );
        const beforeChmod = await permissionHandle.stat();
        if (
          !beforeChmod.isFile() ||
          beforeChmod.isSymbolicLink() ||
          beforeChmod.nlink !== 1 ||
          beforeChmod.dev !== original.dev ||
          beforeChmod.ino !== original.ino
        )
          throw failure("oauth_login_temp_changed");
        await permissionHandle.chmod(0o600);
        const afterChmod = await permissionHandle.stat();
        if (
          (afterChmod.mode & 0o777) !== 0o600 ||
          afterChmod.dev !== original.dev ||
          afterChmod.ino !== original.ino
        )
          throw failure("oauth_login_temp_changed");
      } catch (error) {
        if (error instanceof SafeDiagnosticError) throw error;
        throw failure("oauth_login_temp_changed");
      } finally {
        await permissionHandle?.close().catch(() => {});
      }
      await verifyTemp();
      await writeCredentialsAtomically(credentials, settings);
      await verifyCredentialLocation({ ...settings, allowMissing: false });
      onPhase("oauth_login_complete");
      return { providerId: "chatgpt-oauth", status: "authenticated" };
    } catch (error) {
      throw (
        boundedError ??
        (error instanceof SafeDiagnosticError
          ? error
          : failure("oauth_login_failed"))
      );
    } finally {
      await handle?.close().catch(() => {});
      if (ownsTemp) await fs.unlink(temp).catch(() => {});
    }
  });

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runDedicatedChatGptLogin({ onPhase: (phase) => console.log(phase) }).catch(
    (error) => {
      console.error(sanitizeErrorDiagnostic(error));
      process.exitCode = 1;
    },
  );
}
