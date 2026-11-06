import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveInstagramConfig } from "./publishing-config.mjs";
import { resolveStorageConfig } from "./storage-config.mjs";
import { createPublishingLedger } from "./publishing-ledger.mjs";
import { runPublishingCli } from "./publishing-run.mjs";

const states = new Set(["approved", "uploading", "container_created", "processing"]);
export const dispatchPass = async ({ list, accountId, now, run, output = () => {}, signal }) => {
  const cutoff = Date.parse(now());
  if (!Number.isFinite(cutoff)) throw new Error("Invalid dispatcher clock");
  for (const item of list()) {
    if (signal?.aborted) break;
    const scheduled = Date.parse(item.scheduledAt);
    if (!states.has(item.state) || item.accountId !== accountId || !Number.isFinite(scheduled) || scheduled > cutoff) continue;
    try {
      const result = await run(item.id);
      output({ itemId: item.id, status: result.status });
    } catch {
      output({ itemId: item.id, status: "stopped", errorCode: "DISPATCH_WORKER_ERROR" });
    }
  }
};

export const runDispatcher = async ({ pass, signal, intervalMs = 60000, wait = (ms, signal) => delay(ms, undefined, { signal }) }) => {
  while (!signal.aborted) {
    try { await pass(); } catch { /* retry at the next bounded interval */ }
    if (signal.aborted) break;
    try { await wait(intervalMs, signal); } catch (error) { if (!signal.aborted) throw error; }
  }
};

export const runDispatcherCli = async (argv, { environment = process.env, output = value => console.log(JSON.stringify(value)), signal } = {}) => {
  if (argv.length !== 1 || argv[0] !== "--live") {
    output({ status: "stopped", errorCode: "DISPATCH_LIVE_FLAG_REQUIRED" });
    return 1;
  }
  let ledger;
  try {
    const config = resolveInstagramConfig(environment);
    const storage = resolveStorageConfig(environment);
    // Require an existing DB before opening a ledger that can initialize schema.
    const { realpath } = await import("node:fs/promises");
    await realpath(storage.publishingDb);
    ledger = createPublishingLedger(storage.publishingDb);
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (signal) { if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once:true }); }
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      output({ status: "dispatcher_started" });
      await runDispatcher({ signal: controller.signal, pass: () => dispatchPass({
        list: () => ledger.getQueue({ states: [...states], accountId: config.accountId }),
        accountId: config.accountId, now: () => new Date().toISOString(), signal: controller.signal,
        run: async id => {
          let result = { status: "stopped" };
          await runPublishingCli(["--item", id, "--live"], { environment, output: value => { result = value; } });
          return result;
        }, output,
      }).catch(() => output({status:"stopped", errorCode:"DISPATCH_PASS_ERROR"})) });
      return 0;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      signal?.removeEventListener("abort", stop);
    }
  } catch {
    output({ status: "stopped", errorCode: "DISPATCH_CONFIGURATION_ERROR" });
    return 1;
  } finally { ledger?.close(); }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await runDispatcherCli(process.argv.slice(2));
