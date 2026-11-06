// Optional browser acceptance check. Only temporary databases, logs, and a private Chrome profile.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createPublishingServer } from "./publishing-server.mjs";
import { createJobDebugReader } from "./job-debug-store.mjs";

const root = await mkdtemp(join(tmpdir(), "job-console-browser-"));
const id = "92fd058e-e006-4f69-bce7-c267983fdec8",
  other = "318e8889-e34f-4f37-a393-4fcf69be1c90";
const path = join(root, "jobs.sqlite"),
  runs = join(root, "runs");
const db = new DatabaseSync(path);
db.exec(`CREATE TABLE jobs(job_id TEXT PRIMARY KEY,video_id TEXT,status TEXT,created_at TEXT,updated_at TEXT,result_json TEXT,capture_health TEXT);
CREATE TABLE event_outbox(event_id TEXT,job_id TEXT,event_name TEXT,sequence INTEGER,timestamp TEXT);
CREATE TABLE event_subscriptions(id TEXT,job_id TEXT,event_name TEXT,state TEXT,expires_at INTEGER);
CREATE TABLE event_deliveries(id TEXT,event_id TEXT,subscription_id TEXT,status TEXT,attempts INTEGER,last_code TEXT,http_status INTEGER,acked_at INTEGER);`);
const insert = db.prepare("INSERT INTO jobs VALUES(?,?,?,?,?,?,?)");
insert.run(
  id,
  "fUlMxqntE74",
  "partial",
  "2026-11-05 21:11:07",
  "2026-11-05 21:16:07",
  JSON.stringify({
    title: "AI is hacking the code of civilization",
    artifactPaths: ["one.mp4", "two.mp4"],
    failures: [{ stage: "render", code: "RENDER_FAILED", packageId: "36" }],
  }),
  "complete",
);
insert.run(
  other,
  "videoB",
  "running",
  "2026-11-05 20:00:00",
  "2026-11-05 20:00:00",
  JSON.stringify({ title: "Second job — isolation check" }),
  "complete",
);
for (let i = 0; i < 4; i++) {
  const name = i === 3 ? "audiogram.job.finished" : "audiogram.job.progress";
  db.prepare("INSERT INTO event_outbox VALUES(?,?,?,?,?)").run(
    "event-" + i,
    id,
    name,
    i + 1,
    "2026-11-05T21:16:07Z",
  );
  db.prepare("INSERT INTO event_subscriptions VALUES(?,?,?,?,?)").run(
    "sub-" + i,
    id,
    name,
    "active",
    Date.now() + 86400000,
  );
  db.prepare("INSERT INTO event_deliveries VALUES(?,?,?,?,?,?,?,?)").run(
    "delivery-" + i,
    "event-" + i,
    "sub-" + i,
    "acked",
    i === 2 ? 2 : 1,
    null,
    200,
    Date.now(),
  );
}
db.close();
await mkdir(join(runs, id), { recursive: true });
await mkdir(join(runs, other), { recursive: true });
const log = join(runs, id, "pipeline.jsonl");
const event = (stage, status, clip, sequence) => ({
  jobId: id,
  runId: id,
  sourceId: `source-${sequence}`,
  timestamp: `2026-11-05T21:${String(11 + Math.floor(sequence / 2)).padStart(2, "0")}:07Z`,
  stage,
  status,
  clipPackageId: clip,
  treatmentId: "audiogram-basic",
  ...(status === "completed" ? { durationMs: 28000 } : {}),
  ...(status === "failed" ? { errorCode: "RENDER_FAILED" } : {}),
});
const rows = [
  event("transcript", "completed", 35, 1),
  event("selection", "completed", 35, 2),
  event("jev", "completed", 35, 3),
  event("assets", "completed", 35, 4),
  event("render", "completed", 35, 5),
  event("render", "failed", 36, 6),
  event("render", "completed", 37, 7),
  event("artifact_verification", "completed", 37, 8),
];
await writeFile(log, rows.map((e) => JSON.stringify(e) + "\n").join(""));
await writeFile(
  join(runs, other, "pipeline.jsonl"),
  JSON.stringify({
    jobId: other,
    runId: other,
    stage: "transcript",
    status: "started",
    timestamp: "2026-11-05T20:00:00Z",
  }) + "\n",
);
let unavailable = false;
const reader = createJobDebugReader({
  jobsDbPath: path,
  diagnosticsRoot: runs,
  sourceLabel: "Browser fixture",
});
const server = createPublishingServer({
  ledger: { getQueue: () => [] },
  debugReader: {
    ...reader,
    getJob: (...args) => {
      if (unavailable) throw Error("private detail");
      return reader.getJob(...args);
    },
  },
});
let chrome, socket, exit;
const pending = new Map(),
  errors = [];
let counter = 0;
const command = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++counter;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await command("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails)
    throw Error(
      r.exceptionDetails.text +
        ": " +
        r.exceptionDetails.exception?.description,
    );
  return r.result.value;
};
const waitFor = async (expression) => {
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    if (await evaluate(expression)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Browser condition timed out: " + expression);
};
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chromePath =
    process.env.CHROME_PATH ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  chrome = spawn(
    chromePath,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--remote-debugging-port=0",
      `--user-data-dir=${join(root, "profile")}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  exit = once(chrome, "exit");
  const ws = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(
      () => reject(Error("Chrome start timeout")),
      15000,
    );
    chrome.once("error", reject);
    chrome.stderr.on("data", (b) => {
      text += b;
      const match = text.match(/DevTools listening on (ws:\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  const targets = await (
    await fetch(`http://127.0.0.1:${new URL(ws).port}/json`)
  ).json();
  socket = new WebSocket(
    targets.find((t) => t.type === "page").webSocketDebuggerUrl,
  );
  await once(socket, "open");
  socket.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(Error(m.error.message));
      else p.resolve(m.result);
    }
    if (m.method === "Runtime.exceptionThrown")
      errors.push(m.params.exceptionDetails);
  });
  await command("Runtime.enable");
  await command("Page.enable");
  await command("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await command("Page.navigate", { url: base + "/debug/jobs" });
  await waitFor("document.querySelectorAll('.job-card').length===2");
  assert.match(await evaluate("document.body.innerText"), /Choose a job/);
  await evaluate("document.querySelector('.job-card').click()");
  await waitFor("document.querySelectorAll('tbody tr').length===12");
  assert.match(await evaluate("document.body.innerText"), /RENDER_FAILED/);
  // Exact filter removes other statuses; expanded details remain open after refresh.
  await evaluate(
    "const s=[...document.querySelectorAll('.filter-bar select')].find(e=>e.parentElement.textContent.startsWith('Status'));s.value='failed';s.dispatchEvent(new Event('change',{bubbles:true}));",
  );
  await waitFor(
    "document.querySelector('tbody').querySelectorAll('tr').length===1",
  );
  await evaluate("document.querySelector('.expand').click()");
  await new Promise((r) => setTimeout(r, 2300));
  assert.equal(
    await evaluate("document.querySelectorAll('.detail-row').length"),
    1,
  );
  await evaluate(
    "[...document.querySelectorAll('button')].find(e=>e.textContent==='Clear filters').click()",
  );
  await evaluate(
    "document.querySelector('thead th:nth-child(2) button').click()",
  );
  await waitFor(
    "document.querySelector('thead th:nth-child(2)').getAttribute('aria-sort')==='ascending'",
  );
  await evaluate(
    "document.querySelector('thead th:nth-child(2) button').click()",
  );
  await waitFor(
    "document.querySelector('thead th:nth-child(2)').getAttribute('aria-sort')==='descending'",
  );
  assert.match(
    await evaluate("document.querySelector('tbody tr').innerText"),
    /artifact_verification/,
  );
  // Restore chronological order for Follow.
  await evaluate(
    "document.querySelector('thead th:nth-child(2) button').click()",
  );
  await evaluate(
    "[...document.querySelectorAll('button')].find(e=>e.textContent==='Pause updates').click()",
  );
  await waitFor(
    "document.querySelector('.refresh-line').innerText.includes('paused')",
  );
  await appendFile(
    log,
    JSON.stringify(event("render", "started", 38, 9)) + "\n",
  );
  await new Promise((r) => setTimeout(r, 2300));
  assert.equal(
    await evaluate("document.querySelector('tbody').innerText.includes('38')"),
    false,
  );
  await evaluate(
    "[...document.querySelectorAll('button')].find(e=>e.textContent==='Resume updates').click()",
  );
  await waitFor("document.querySelector('tbody').innerText.includes('38')");
  const screenshot = await command("Page.captureScreenshot", { format: "png" });
  await writeFile(
    "/tmp/audiogram-job-console-desktop.png",
    Buffer.from(screenshot.data, "base64"),
  );
  await evaluate("[...document.querySelectorAll('[role=tab]')][1].click()");
  await waitFor(
    "document.body.innerText.includes('Historical attempt details are unavailable')",
  );
  await evaluate("document.querySelectorAll('.job-card')[1].click()");
  await waitFor(
    "document.querySelector('.job-heading').innerText.includes('Second job')",
  );
  assert.ok(
    !(await evaluate("document.querySelector('.job-view').innerText")).includes(
      "RENDER_FAILED",
    ),
  );
  unavailable = true;
  await waitFor(
    "document.querySelector('.refresh-line').innerText.includes('Stale')",
  );
  assert.ok(
    !(await evaluate("document.body.innerText")).includes("private detail"),
  );
  unavailable = false;
  await command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(
    await evaluate("document.documentElement.scrollWidth <= window.innerWidth"),
  );
  await writeFile(
    "/tmp/audiogram-job-console-mobile.png",
    Buffer.from(
      (await command("Page.captureScreenshot", { format: "png" })).data,
      "base64",
    ),
  );
  await command("Page.navigate", { url: base + "/" });
  await waitFor("document.body.innerText.includes('0 candidates')");
  assert.equal(
    await evaluate("!!document.querySelector('.activity-panel')"),
    false,
  );
  assert.equal(
    await evaluate(
      "document.querySelector('a[href=\"/debug/jobs\"]').textContent",
    ),
    "Debug jobs ↗",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS browser: recent jobs, filters, expansion, live append, deliveries, job isolation, stale read, mobile layout, publishing navigation.",
  );
  console.log(
    "Screenshots: /tmp/audiogram-job-console-desktop.png /tmp/audiogram-job-console-mobile.png",
  );
} finally {
  if (socket?.readyState === 1) {
    await command("Browser.close").catch(() => {});
    socket.close();
  }
  chrome?.kill();
  if (exit) await exit;
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}
