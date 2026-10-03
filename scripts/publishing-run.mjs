import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveInstagramConfig } from "./publishing-config.mjs";
import { createInstagramClient, InstagramError } from "./instagram-client.mjs";
import { createPublishingLedger } from "./publishing-ledger.mjs";
import { createPublishingExecution, acquireWorkerLock } from "./publishing-execution.mjs";
import { runPublishingOnce } from "./publishing-worker.mjs";

const parse = (argv) => {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (!["--db", "--project-root", "--item", "--live", "--check-account"].includes(name) || name in options) throw new Error("Invalid arguments");
    if (["--live", "--check-account"].includes(name)) options[name] = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("Missing argument");
      options[name] = value;
    }
  }
  if (options["--check-account"]) {
    if (Object.keys(options).length !== 1) throw new Error("Account check cannot be combined with write options");
  } else if (!options["--live"] || !isAbsolute(options["--db"] ?? "") || !isAbsolute(options["--project-root"] ?? "") || !options["--item"]) {
    throw new Error("Required: --db ABSOLUTE_PATH --project-root ABSOLUTE_PATH --item ID --live, or --check-account");
  }
  return options;
};

export const runPublishingCli = async (argv, {
  environment = process.env, output = (value) => console.log(JSON.stringify(value)),
  makeClient = createInstagramClient, makeLedger = createPublishingLedger,
} = {}) => {
  let ledger, execution, lock;
  try {
    const args = parse(argv);
    const config = resolveInstagramConfig(environment);
    const client = makeClient(config);
    if (args["--check-account"]) {
      const identity = { pageId: config.pageId, accountId: config.accountId, username: config.username };
      await client.verifyAccount(identity);
      output({ status: "account_verified", ...identity });
      return 0;
    }
    // Existing approved ledger required. realpath in lock acquisition refuses a
    // misspelled/nonexistent DB instead of creating a silently empty queue.
    lock = await acquireWorkerLock(args["--db"]);
    ledger = makeLedger(args["--db"]);
    execution = createPublishingExecution(args["--db"]);
    const outcome = await runPublishingOnce({ ledger, execution, lock, client, config: { ...config, projectRoot: args["--project-root"] }, itemId: args["--item"] });
    output(outcome);
    return outcome.status === "published" ? 0 : outcome.status === "pending" ? 2 : 1;
  } catch (error) {
    output({ status: "stopped", errorCode: error instanceof InstagramError ? error.code : "CONFIGURATION_OR_WORKER_ERROR",
      ...(error instanceof InstagramError ? { operation: error.operation, httpStatus: error.httpStatus, providerCode: error.providerCode } : {}),
      ...(typeof error.confirmedMediaId === "string" && /^[0-9]+$/.test(error.confirmedMediaId) ? { confirmedMediaId: error.confirmedMediaId } : {}),
    });
    return 1;
  } finally {
    execution?.close(); ledger?.close();
    if (lock) {
      try { await lock.release(); }
      catch { output({ status: "lock_retained", errorCode: "LOCK_OWNERSHIP_LOST" }); }
    }
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runPublishingCli(process.argv.slice(2));
