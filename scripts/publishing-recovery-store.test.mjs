import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openRecoveryStore } from "./publishing-recovery-store.mjs";

test("read-only store never creates missing databases or migrates old schemas", async t => {
  const root = await mkdtemp(join(tmpdir(), "recovery-read-")); t.after(() => rm(root, {recursive:true, force:true}));
  const path = join(root, "missing.sqlite");
  assert.throws(() => openRecoveryStore(path));
  await assert.rejects(stat(path), {code:"ENOENT"});
  const db = new DatabaseSync(path); db.exec("CREATE TABLE old(value TEXT)"); db.close();
  const store = openRecoveryStore(path); t.after(() => store.close());
  assert.throws(() => store.readSnapshot("item"), /schema/i);
  const check = new DatabaseSync(path, {readOnly:true});
  assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name), ["old"]); check.close();
});
