import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import { google } from "googleapis";

import {
  findPlaylistByTitle,
  mergeOAuthTokens,
  parseInstalledClient,
} from "./youtube-auth-core.mjs";
import { collectPlaylistItems } from "./youtube-playlist-core.mjs";

const appSupportDirectory = join(
  homedir(),
  "Library",
  "Application Support",
  "Audiogram Inbox",
);
const clientPath =
  process.env.AUDIOGRAM_GOOGLE_CLIENT_PATH ??
  join(appSupportDirectory, "google-oauth-client.json");
const tokenPath =
  process.env.AUDIOGRAM_GOOGLE_TOKEN_PATH ??
  join(appSupportDirectory, "google-oauth-token.json");
const playlistTitle =
  process.env.AUDIOGRAM_YOUTUBE_PLAYLIST ?? "Audiogram Inbox";
const scope = "https://www.googleapis.com/auth/youtube.readonly";

const clientConfig = JSON.parse(await readFile(clientPath, "utf8"));
const { clientId, clientSecret } = parseInstalledClient(clientConfig);

let oauth2Client;
let storedTokens;

try {
  storedTokens = JSON.parse(await readFile(tokenPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}

if (storedTokens) {
  oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials(storedTokens);
} else {
  await new Promise((resolve, reject) => {
    const state = randomBytes(32).toString("hex");
    const server = createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url, "http://127.0.0.1");

        if (requestUrl.pathname !== "/oauth2callback") {
          response.writeHead(404).end("Not found");
          return;
        }

        if (requestUrl.searchParams.get("state") !== state) {
          throw new Error("OAuth state mismatch");
        }

        const error = requestUrl.searchParams.get("error");
        if (error) {
          throw new Error(`Google OAuth returned: ${error}`);
        }

        const code = requestUrl.searchParams.get("code");
        if (!code) {
          throw new Error("Google OAuth callback did not include a code");
        }

        const { tokens } = await oauth2Client.getToken(code);
        storedTokens = mergeOAuthTokens({}, tokens);
        await writeFile(
          tokenPath,
          `${JSON.stringify(storedTokens, null, 2)}\n`,
          {
            mode: 0o600,
          },
        );
        oauth2Client.setCredentials(storedTokens);

        response.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end(
          "Audiogram Inbox authorization complete. You can close this tab.",
        );
        server.close();
        resolve();
      } catch (error) {
        response.writeHead(400, {
          "Content-Type": "text/plain; charset=utf-8",
        });
        response.end(`Authorization failed: ${error.message}`);
        server.close();
        reject(error);
      }
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
      oauth2Client = new google.auth.OAuth2(
        clientId,
        clientSecret,
        redirectUri,
      );

      const authorizationUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        include_granted_scopes: true,
        prompt: "consent",
        scope,
        state,
      });

      console.log(`AUTHORIZATION_URL=${authorizationUrl}`);
    });
  });
}

oauth2Client.on("tokens", async (tokens) => {
  storedTokens = mergeOAuthTokens(storedTokens, tokens);
  await writeFile(tokenPath, `${JSON.stringify(storedTokens, null, 2)}\n`, {
    mode: 0o600,
  });
});

const youtube = google.youtube({ version: "v3", auth: oauth2Client });
const playlist = await findPlaylistByTitle(async (pageToken) => {
  const response = await youtube.playlists.list({
    maxResults: 50,
    mine: true,
    pageToken,
    part: ["snippet"],
  });

  return response.data;
}, playlistTitle);

if (!playlist) {
  console.log(
    JSON.stringify(
      {
        playlist: null,
        videos: [],
        message: `Create a private YouTube playlist named ${playlistTitle} and run this command again.`,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const videos = await collectPlaylistItems(async (pageToken) => {
  const response = await youtube.playlistItems.list({
    maxResults: 50,
    pageToken,
    part: ["snippet"],
    playlistId: playlist.id,
  });

  return response.data;
});

console.log(JSON.stringify({ playlist, videos }, null, 2));
