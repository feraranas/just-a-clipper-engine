import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtemp,
  mkdir,
  writeFile,
  appendFile,
  rm,
  symlink,
  access,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJobDebugReader } from "./job-debug-store.mjs";

const a = "92fd058e-e006-4f69-bce7-c267983fdec8";
const b = "318e8889-e34f-4f37-a393-4fcf69be1c90";
export async function debugFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "job-debug-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobsDbPath = join(root, "jobs.sqlite");
  const db = new DatabaseSync(jobsDbPath);
  db.exec(`CREATE TABLE jobs(job_id TEXT PRIMARY KEY,video_id TEXT,status TEXT,created_at TEXT,updated_at TEXT,result_json TEXT,capture_health TEXT);
    CREATE TABLE event_outbox(event_id TEXT,job_id TEXT,event_name TEXT,sequence INTEGER,timestamp TEXT);
    CREATE TABLE event_deliveries(id TEXT,event_id TEXT,subscription_id TEXT,status TEXT,attempts INTEGER,last_code TEXT,http_status INTEGER,acked_at INTEGER);
    CREATE TABLE event_subscriptions(id TEXT,job_id TEXT,event_name TEXT,state TEXT,expires_at INTEGER,callback_url TEXT,secret_box TEXT);`);
  const insert = db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?)");
  insert.run(
    a,
    "videoA",
    "partial",
    "2026-11-05 21:00:00",
    "2026-11-05 21:06:00",
    JSON.stringify({
      title: "Example A",
      artifactPaths: ["a.mp4"],
      failures: [
        {
          stage: "render",
          code: "RENDER_FAILED",
          packageId: 36,
          message: "PRIVATE",
        },
      ],
      secret: "PRIVATE",
      diagnosticsIncomplete: true,
    }),
    "complete",
  );
  insert.run(
    b,
    "videoB",
    "running",
    "2026-11-05 20:00:00",
    "2026-11-05 20:00:00",
    null,
    "unknown",
  );
  db.prepare("INSERT INTO event_outbox VALUES(?,?,?,?,?)").run(
    "evt-a",
    a,
    "audiogram.job.finished",
    25,
    "2026-11-05T21:06:00Z",
  );
  db.prepare("INSERT INTO event_subscriptions VALUES(?,?,?,?,?,?,?)").run(
    "sub-a",
    a,
    "audiogram.job.finished",
    "active",
    Date.now() + 60000,
    "https://PRIVATE",
    "PRIVATE",
  );
  db.prepare("INSERT INTO event_deliveries VALUES(?,?,?,?,?,?,?,?)").run(
    "delivery-a",
    "evt-a",
    "sub-a",
    "acked",
    2,
    null,
    200,
    Date.now(),
  );
  db.close();
  const diagnosticsRoot = join(root, "runs");
  await mkdir(join(diagnosticsRoot, a), { recursive: true });
  const log = join(diagnosticsRoot, a, "pipeline.jsonl");
  const event = {
    jobId: a,
    runId: a,
    stage: "render",
    status: "started",
    timestamp: "2026-11-05T21:00:00Z",
    sourceId: "event-1",
    message: "PRIVATE",
  };
  await writeFile(
    log,
    JSON.stringify(event) +
      "\n" +
      JSON.stringify({ ...event, jobId: b, runId: b }) +
      "\nbroken\n" +
      JSON.stringify({ ...event, sourceId: "event-2", status: "completed" }) +
      '\n{"stage":',
  );
  return {
    root,
    jobsDbPath,
    diagnosticsRoot,
    log,
    event,
    reader: createJobDebugReader({
      jobsDbPath,
      diagnosticsRoot,
      sourceLabel: "Fixture",
    }),
  };
}
test("recent jobs use stable cursors and summaries exclude private payloads", async (t) => {
  const f = await debugFixture(t);
  const first = f.reader.listJobs({ limit: 1 });
  assert.equal(first.jobs[0].jobId, a);
  assert.ok(first.nextCursor);
  const db = new DatabaseSync(f.jobsDbPath);
  db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?)").run(
    "11111111-1111-4111-8111-111111111111",
    "v",
    "queued",
    "2026-11-06",
    "2026-11-06",
    null,
    "unknown",
  );
  db.close();
  assert.equal(
    f.reader.listJobs({ limit: 1, cursor: first.nextCursor }).jobs[0].jobId,
    b,
  );
  const detail = f.reader.getJob(a);
  assert.equal(detail.job.artifactCount, 1);
  assert.equal(detail.job.failures[0].code, "RENDER_FAILED");
  assert.equal(detail.job.diagnosticsIncomplete, true);
  assert.ok(!JSON.stringify(detail).includes("PRIVATE"));
  assert.throws(() => f.reader.getJob("../../secret"), /Invalid/);
  assert.throws(() => f.reader.listJobs({ cursor: "bad" }), /cursor/);
});
test("event pages scope jobs, retain old rows, expose damage, and resume partial appends", async (t) => {
  const f = await debugFixture(t);
  const first = await f.reader.events(a, { limit: 1 });
  assert.equal(first.events.length, 1);
  assert.ok(first.nextCursor);
  const second = await f.reader.events(a, {
    cursor: first.nextCursor,
    limit: 10,
  });
  assert.equal(second.events[0].status, "completed");
  assert.ok(second.malformed > 0);
  assert.equal(second.incompleteLine, true);
  assert.ok(!JSON.stringify(first).includes("PRIVATE"));
  assert.notEqual(first.events[0].id, second.events[0].id);
  await appendFile(
    f.log,
    "\n" +
      JSON.stringify({ ...f.event, sourceId: "event-3", status: "failed" }) +
      "\n",
  );
  const next = await f.reader.events(a, { cursor: second.cursor, limit: 10 });
  assert.equal(next.events.at(-1).status, "failed");
  assert.equal((await f.reader.events(b)).availability, "missing");
});
test("delivery results expose safe fields and acknowledge missing attempt history", async (t) => {
  const f = await debugFixture(t),
    result = f.reader.deliveries(a);
  assert.equal(result.deliveries[0].attempts, 2);
  assert.equal(result.deliveries[0].status, "acked");
  assert.equal(result.attemptHistoryAvailable, false);
  assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  assert.deepEqual(f.reader.deliveries(b).deliveries, []);
});
test("notification health distinguishes stopped deliveries, retries, and expired subscriptions", async (t) => {
  const f = await debugFixture(t);
  const db = new DatabaseSync(f.jobsDbPath);
  t.after(() => db.close());
  db.prepare("UPDATE event_deliveries SET status='stopped',attempts=3").run();
  assert.equal(f.reader.getJob(a).notification.delivery, "stopped");
  db.prepare("UPDATE event_deliveries SET status='pending',attempts=1").run();
  assert.equal(f.reader.getJob(a).notification.delivery, "degraded");
  db.prepare("UPDATE event_subscriptions SET expires_at=0").run();
  db.prepare("INSERT INTO event_subscriptions VALUES(?,?,?,?,?,?,?)").run(
    "replacement", a, "audiogram.job.finished", "active", Date.now() + 60000, "", "",
  );
  assert.equal(f.reader.getJob(a).notification.delivery, "active");
});
test("missing sources are not created and symlink escapes are rejected", async (t) => {
  const f = await debugFixture(t);
  const missing = join(f.root, "missing.sqlite");
  const reader = createJobDebugReader({
    jobsDbPath: missing,
    diagnosticsRoot: f.diagnosticsRoot,
  });
  assert.throws(() => reader.listJobs(), /unavailable/);
  await assert.rejects(access(missing));
  await rm(f.log);
  await symlink(join(f.root, "jobs.sqlite"), f.log);
  await assert.rejects(f.reader.events(a), /outside|unsafe/i);
});
test("reads leave schemas and stored results unchanged", async (t) => {
  const f = await debugFixture(t),
    db = new DatabaseSync(f.jobsDbPath);
  const before = db.prepare("SELECT * FROM sqlite_master").all();
  f.reader.listJobs();
  f.reader.getJob(a);
  f.reader.deliveries(a);
  await f.reader.events(a);
  assert.deepEqual(db.prepare("SELECT * FROM sqlite_master").all(), before);
  assert.equal(
    db.prepare("SELECT status FROM jobs WHERE job_id=?").get(a).status,
    "partial",
  );
  db.close();
});

test("bounded event pages retain every record and detect replaced or truncated logs", async (t) => {
  const f = await debugFixture(t);
  const records = Array.from({ length: 205 }, (_, i) =>
    JSON.stringify({ ...f.event, sourceId: `record-${i}` }),
  );
  await writeFile(f.log, records.join("\n") + "\n");
  const first = await f.reader.events(a);
  const second = await f.reader.events(a, { cursor: first.nextCursor });
  const third = await f.reader.events(a, { cursor: second.nextCursor });
  assert.equal(first.events.length, 100);
  assert.equal(second.events.length, 100);
  assert.equal(third.events.length, 5);
  assert.equal(third.nextCursor, null);
  assert.equal(
    new Set(
      [...first.events, ...second.events, ...third.events].map((e) => e.id),
    ).size,
    205,
  );
  await assert.rejects(f.reader.events(b, { cursor: first.cursor }), /cursor/);
  await assert.rejects(f.reader.events(a, { limit: 501 }), /Invalid/);
  await writeFile(f.log, records[0] + "\n");
  assert.equal(
    (await f.reader.events(a, { cursor: first.cursor })).reset,
    true,
  );
  await rename(f.log, f.log + ".old");
  await writeFile(f.log, records.join("\n") + "\n");
  assert.equal(
    (await f.reader.events(a, { cursor: first.cursor })).reset,
    true,
  );
  await writeFile(f.log, "x".repeat(1024 * 1024));
  await assert.rejects(f.reader.events(a), /read limit/);
});
