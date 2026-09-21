import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import { google } from "googleapis";

import { openAudiogramLedger } from "./audiogram-ledger.mjs";
import { createPublishingLedger } from "./publishing-ledger.mjs";
import { enqueueCompletedArtifact } from "./publishing-completion.mjs";
import { acquireClipPackageAssets } from "./clip-package-assets.mjs";
import { processClipPackages } from "./clip-processing-core.mjs";
import {
  findPlaylistByTitle,
  mergeOAuthTokens,
  parseInstalledClient,
} from "./youtube-auth-core.mjs";
import { syncAndAnalyzeInbox } from "./youtube-inbox-pipeline-core.mjs";
import { collectPlaylistItems } from "./youtube-playlist-core.mjs";
import { renderTreatmentRun } from "./treatment-runner.mjs";
import { treatmentRegistry } from "./treatment-registry.mjs";
import { resolvePackageVersion } from "./youtube-pipeline-config.mjs";

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
const ledgerPath =
  process.env.AUDIOGRAM_DB_PATH ??
  join(appSupportDirectory, "audiograms.sqlite");
const publishingAccountId = process.env.INSTAGRAM_ACCOUNT_ID;
const publishingLedgerPath =
  process.env.INSTAGRAM_PUBLISHING_DB_PATH ??
  join(appSupportDirectory, "instagram-publishing.sqlite");
const playlistTitle =
  process.env.AUDIOGRAM_YOUTUBE_PLAYLIST ?? "Audiogram Inbox";
const packageVersion = resolvePackageVersion(process.env);
const maxClips = Number.parseInt(process.env.AUDIOGRAM_MAX_CLIPS ?? "1", 10);
const minimumSeparationSeconds = Number.parseFloat(
  process.env.AUDIOGRAM_MINIMUM_CLIP_SEPARATION_SECONDS ?? "20",
);
const scope = "https://www.googleapis.com/auth/youtube.readonly";

if (!Number.isInteger(maxClips) || maxClips < 1) {
  throw new Error("AUDIOGRAM_MAX_CLIPS must be a positive integer");
}

if (
  !Number.isFinite(minimumSeparationSeconds) ||
  minimumSeparationSeconds < 0
) {
  throw new Error(
    "AUDIOGRAM_MINIMUM_CLIP_SEPARATION_SECONDS must be a non-negative number",
  );
}

await mkdir(appSupportDirectory, { recursive: true, mode: 0o700 });

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

const ledger = openAudiogramLedger(ledgerPath);
const publishingLedger = publishingAccountId
  ? createPublishingLedger(publishingLedgerPath)
  : null;

try {
  const pipeline = await syncAndAnalyzeInbox({
    ledger,
    maxClips,
    minimumSeparationSeconds,
    playlist,
    packageVersion,
    videos,
  });
  const processing = await processClipPackages({
    ledger,
    registry: treatmentRegistry,
    treatments: [{ id: "audiogram-basic", version: "1" }],
    acquireAssets: (clipPackage) =>
      acquireClipPackageAssets(clipPackage, { projectRoot: process.cwd() }),
    renderTreatment: ({ clipPackage, treatment }) =>
      renderTreatmentRun(
        { clipPackage, treatment },
        { projectRoot: process.cwd() },
      ),
    projectRoot: process.cwd(),
    onArtifactComplete: publishingLedger
      ? ({ artifactRelativePath, artifactHash, clipPackage, treatment }) =>
          enqueueCompletedArtifact({
            ledger: publishingLedger,
            projectRoot: process.cwd(),
            artifactRelativePath,
            artifactHash,
            accountId: publishingAccountId,
            sourceVideoId: clipPackage.sourceVideoId,
            clipPackageId: clipPackage.id,
            treatmentId: treatment.id,
            treatmentVersion: treatment.version,
            title: clipPackage.title,
          })
      : undefined,
  });
  const analysisFailures = pipeline.analyzed.filter(
    ({ status }) => status === "failed",
  );

  console.log(
    JSON.stringify(
      {
        playlist,
        packageVersion,
        treatments: ["audiogram-basic@1"],
        ledgerPath,
        videosFound: videos.length,
        ...pipeline,
        processing,
      },
      null,
      2,
    ),
  );

  if (
    analysisFailures.length > 0 ||
    processing.packages.failed > 0 ||
    processing.treatments.failed > 0
  ) {
    process.exitCode = 1;
  }
} finally {
  ledger.close();
  publishingLedger?.close();
}
