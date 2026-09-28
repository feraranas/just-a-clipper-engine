import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { google } from "googleapis";

import { mergeOAuthTokens, parseInstalledClient } from "./youtube-auth-core.mjs";

const appSupportDirectory = join(homedir(), "Library", "Application Support", "Audiogram Inbox");
const defaultClientPath = join(appSupportDirectory, "google-oauth-client.json");
const defaultTokenPath = join(appSupportDirectory, "google-oauth-token.json");
const scope = "https://www.googleapis.com/auth/youtube.readonly";

export const resolveYoutubeOAuthPaths = (environment = process.env) => ({
  clientPath: environment.AUDIOGRAM_GOOGLE_CLIENT_PATH ?? defaultClientPath,
  tokenPath: environment.AUDIOGRAM_GOOGLE_TOKEN_PATH ?? defaultTokenPath,
});

export const runYoutubeLogin = async ({ clientPath, tokenPath, log = console.log } = {}) => {
  const defaults = resolveYoutubeOAuthPaths();
  const paths = {
    clientPath: clientPath ?? defaults.clientPath,
    tokenPath: tokenPath ?? defaults.tokenPath,
  };
  const clientConfig = JSON.parse(await readFile(paths.clientPath, "utf8"));
  const { clientId, clientSecret } = parseInstalledClient(clientConfig);
  await mkdir(dirname(paths.tokenPath), { recursive: true, mode: 0o700 });

  await new Promise((resolveLogin, rejectLogin) => {
    const state = randomBytes(32).toString("hex");
    let oauth2Client;
    const server = createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url, "http://127.0.0.1");
        if (requestUrl.pathname !== "/oauth2callback") {
          response.writeHead(404).end("Not found");
          return;
        }
        if (requestUrl.searchParams.get("state") !== state) throw new Error("OAuth state mismatch");
        const error = requestUrl.searchParams.get("error");
        if (error) throw new Error(`Google OAuth returned: ${error}`);
        const code = requestUrl.searchParams.get("code");
        if (!code) throw new Error("Google OAuth callback did not include a code");
        const { tokens } = await oauth2Client.getToken(code);
        const storedTokens = mergeOAuthTokens({}, tokens);
        if (!storedTokens.refresh_token) throw new Error("Google OAuth did not return a refresh token; revoke the existing grant and retry");
        await writeFile(paths.tokenPath, `${JSON.stringify(storedTokens, null, 2)}\n`, { mode: 0o600 });
        response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Audiogram Inbox Google authorization complete. You can close this tab.");
        server.close();
        resolveLogin();
      } catch (error) {
        response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(`Authorization failed: ${error.message}`);
        server.close();
        rejectLogin(error);
      }
    });
    server.on("error", rejectLogin);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
      oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
      const authorizationUrl = oauth2Client.generateAuthUrl({ access_type: "offline", include_granted_scopes: true, prompt: "consent", scope, state });
      log(`Open this URL in your browser:\n${authorizationUrl}`);
    });
  });

  log(`Google OAuth token saved to ${paths.tokenPath}`);
};

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) await runYoutubeLogin();
