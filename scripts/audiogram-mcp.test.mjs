import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const providerKeys = [
  "AUDIOGRAM_LLM_PROVIDER",
  "AUDIOGRAM_CLIP_SELECTOR",
  "AUDIOGRAM_CHATGPT_AUTH_PATH",
  "OPENAI_API_KEY",
  "TYPESAFE_JEV_ENDPOINT",
  "TYPESAFE_JEV_API_KEY",
];

function cleanEnvironment(tempRoot, overrides = {}) {
  const environment = { ...process.env };
  for (const key of providerKeys) delete environment[key];
  Object.assign(environment, {
    AUDIOGRAM_MCP_PORT: "0",
    AUDIOGRAM_PROJECT_ROOT: tempRoot,
    AUDIOGRAM_JOB_STORE: path.join(tempRoot, "jobs.sqlite"),
  });
  Object.assign(environment, overrides);
  return environment;
}

function runMcp(environment, startupRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "audiogram:mcp"], {
      cwd: startupRoot,
      detached: true,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const signalGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };
    let output = "";
    let sawListening = false;
    const timer = setTimeout(() => signalGroup("SIGKILL"), 5000);
    const collect = (chunk) => {
      output += chunk.toString();
      if (!sawListening && output.includes("Audiogram MCP listening on")) {
        sawListening = true;
        signalGroup("SIGTERM");
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output, sawListening });
    });
  });
}

test("MCP startup loads local env, validates settings, and accepts cloud env", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "audiogram-mcp-env-"));
  const envFile = path.join(tempRoot, ".env");
  try {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
    const startupCommand = packageJson.scripts["audiogram:mcp"].replace(
      "plugins/audiogram-helper/server.mjs",
      JSON.stringify(path.join(projectRoot, "plugins/audiogram-helper/server.mjs")),
    );
    await writeFile(path.join(tempRoot, "package.json"), JSON.stringify({ scripts: { "audiogram:mcp": startupCommand } }));
    const missingProvider = await runMcp(cleanEnvironment(tempRoot), tempRoot);
    assert.equal(missingProvider.sawListening, false);
    assert.equal(missingProvider.code, 1);
    assert.match(
      missingProvider.output,
      /AUDIOGRAM_LLM_PROVIDER must explicitly select openai-api or chatgpt-oauth/,
    );

    await writeFile(envFile, await readFile(path.join(projectRoot, ".env.example"), "utf8"), {
      flag: "wx",
      mode: 0o600,
    });
    const copiedExample = await runMcp(cleanEnvironment(tempRoot), tempRoot);
    assert.equal(copiedExample.sawListening, false);
    assert.equal(copiedExample.code, 1);
    assert.match(copiedExample.output, /TYPESAFE_JEV_ENDPOINT and TYPESAFE_JEV_API_KEY must be provided together/);
    const localEnv = await runMcp(cleanEnvironment(tempRoot, {
      TYPESAFE_JEV_ENDPOINT: "https://jev.example.test/v1/judge",
      TYPESAFE_JEV_API_KEY: "synthetic-key",
    }), tempRoot);
    assert.equal(localEnv.sawListening, true);
    assert.ok(localEnv.code === 0 || localEnv.signal === "SIGTERM");
    await unlink(envFile);

    const cloudEnv = await runMcp(
      cleanEnvironment(tempRoot, {
        AUDIOGRAM_LLM_PROVIDER: "chatgpt-oauth",
      }),
      tempRoot,
    );
    assert.equal(cloudEnv.sawListening, true);
    assert.ok(cloudEnv.code === 0 || cloudEnv.signal === "SIGTERM");

    const incompleteJev = await runMcp(
      cleanEnvironment(tempRoot, {
        AUDIOGRAM_LLM_PROVIDER: "chatgpt-oauth",
        TYPESAFE_JEV_ENDPOINT: "https://jev.example.test",
      }),
      tempRoot,
    );
    assert.equal(incompleteJev.sawListening, false);
    assert.equal(incompleteJev.code, 1);
    assert.match(
      incompleteJev.output,
      /TYPESAFE_JEV_ENDPOINT and TYPESAFE_JEV_API_KEY must be provided together/,
    );
    for (const [overrides, expectedError] of [
      [{ TYPESAFE_JEV_ENDPOINT: "http://jev.example.test", TYPESAFE_JEV_API_KEY: "synthetic-key" }, /TYPESAFE_JEV_ENDPOINT must be an HTTPS URL/],
      [{ TYPESAFE_JEV_ENDPOINT: "https://", TYPESAFE_JEV_API_KEY: "synthetic-key" }, /TYPESAFE_JEV_ENDPOINT must be an HTTPS URL/],
      [{ TYPESAFE_JEV_ENDPOINT: "https://jev.example.test", TYPESAFE_JEV_API_KEY: "   " }, /TYPESAFE_JEV_API_KEY must be nonblank/],
      [{ AUDIOGRAM_CHATGPT_AUTH_PATH: "./.credentials/chatgpt-auth.json" }, /AUDIOGRAM_CHATGPT_AUTH_PATH must be an absolute normalized path/],
      [{ AUDIOGRAM_CHATGPT_AUTH_PATH: path.join(tempRoot, "auth.json") }, /AUDIOGRAM_CHATGPT_AUTH_PATH must be an absolute normalized path/],
    ]) {
      const invalid = await runMcp(cleanEnvironment(tempRoot, { AUDIOGRAM_LLM_PROVIDER: "chatgpt-oauth", ...overrides }), tempRoot);
      assert.equal(invalid.sawListening, false);
      assert.equal(invalid.code, 1);
      assert.match(invalid.output, expectedError);
      assert.ok(!invalid.output.includes("synthetic-key"));
    }
  } finally {
    await unlink(envFile).catch(() => {});
    await rm(tempRoot, { recursive: true, force: true });
  }
});
