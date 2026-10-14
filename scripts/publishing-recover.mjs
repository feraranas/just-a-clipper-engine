import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStorageConfig } from "./storage-config.mjs";
import { resolveInstagramConfig } from "./publishing-config.mjs";
import { createInstagramClient } from "./instagram-client.mjs";
import { acquireWorkerLock } from "./publishing-execution.mjs";
import { openRecoveryStore } from "./publishing-recovery-store.mjs";
import { inspectRecovery } from "./publishing-recovery.mjs";

const parse = argv => {
  const args = {};
  for (let i=0; i<argv.length; i++) {
    const key=argv[i];
    if (!["--db","--project-root","--item","--apply","--expected-attempt","--expected-container"].includes(key) || Object.hasOwn(args,key)) throw new Error("Invalid arguments");
    if (key === "--apply") args[key]=true;
    else { const value=argv[++i]; if (!value || value.startsWith("--")) throw new Error("Missing value"); args[key]=value; }
  }
  if (!args["--item"] || ["--db","--project-root"].some(k=>args[k]!==undefined && !isAbsolute(args[k]))) throw new Error("Invalid target");
  if (args["--apply"] ? !args["--expected-attempt"] || !/^[0-9]+$/.test(args["--expected-container"] ?? "") : args["--expected-attempt"] || args["--expected-container"]) throw new Error("Expected identifiers required only for apply");
  return args;
};

export const runRecoveryCli = async (argv, {
  environment=process.env, output=value=>console.log(JSON.stringify(value)),
  makeClient=createInstagramClient, makeStore=openRecoveryStore, acquireLock=acquireWorkerLock,
}={}) => {
  let store, lock;
  try {
    const args=parse(argv), storage=resolveStorageConfig(environment);
    const config={...resolveInstagramConfig(environment), projectRoot:args["--project-root"] ?? process.cwd(), artifactRoot:storage.artifactRoot};
    const path=args["--db"] ?? storage.publishingDb;
    if (args["--apply"]) lock=await acquireLock(path);
    store=makeStore(path);
    const inspection=await inspectRecovery({store,client:makeClient(config),config,itemId:args["--item"]});
    if (!args["--apply"]) { output(inspection); return inspection.eligible ? 0 : 1; }
    if (!inspection.eligible) { output(inspection); return 1; }
    if (inspection.expected.attemptId !== args["--expected-attempt"] || inspection.expected.containerId !== args["--expected-container"]) { output({status:"stopped",reasonCode:"EXPECTED_IDENTIFIERS_MISMATCH"}); return 1; }
    await lock.assertOwned();
    output(store.applyRecovery(inspection));
    return 0;
  } catch {
    // Provider messages, paths and credentials must never reach stdout.
    output({status:"stopped",reasonCode:"RECOVERY_CHECK_FAILED"}); return 1;
  } finally {
    store?.close();
    if (lock) try { await lock.release(); } catch { output({status:"lock_retained",reasonCode:"LOCK_OWNERSHIP_LOST"}); }
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode=await runRecoveryCli(process.argv.slice(2));
