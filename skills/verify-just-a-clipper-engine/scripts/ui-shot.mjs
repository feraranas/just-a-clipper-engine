#!/usr/bin/env node
// ui-shot.mjs URL OUT.png [WAIT_MS] — screenshot a local page through headless Chrome's DevTools
// protocol and print document.body.innerText. Plain `chrome --screenshot` never settles on the
// approval UI (it polls every 2 s), so this waits a fixed time instead. Uses a throwaway profile.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
const [url, out, waitMs = "4000"] = process.argv.slice(2);
if (!url || !out) { console.error("usage: ui-shot.mjs URL OUT.png [WAIT_MS]"); process.exit(2); }
const bin = process.env.CHROME_PATH || execSync("command -v google-chrome || command -v chromium", { shell: "/bin/bash" }).toString().trim();
const prof = mkdtempSync("/tmp/verify-clipper-shot-");
const chrome = spawn(bin, ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${prof}`, "--window-size=900,1600", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const exited = new Promise((r) => chrome.once("exit", r));
let code = 0;
try {
  const ws = await new Promise((res, rej) => {
    let b = "";
    chrome.stderr.on("data", (d) => { b += d; const m = b.match(/DevTools listening on (ws:\S+)/); if (m) res(m[1]); });
    setTimeout(() => rej(new Error("Chrome DevTools did not start")), 15000);
  });
  const targets = await (await fetch(`http://127.0.0.1:${new URL(ws).port}/json`)).json();
  const sock = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  sock.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  await new Promise((r) => (sock.onopen = r));
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  await send("Page.navigate", { url });
  await new Promise((r) => setTimeout(r, Number(waitMs)));
  console.log((await send("Runtime.evaluate", { expression: "document.body.innerText", returnByValue: true })).result.result.value);
  writeFileSync(out, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
  await send("Browser.close");
  sock.close();
} catch (error) { console.error(`ui-shot: ${error.message}`); code = 1; }
finally {
  // Browser.close lets Chrome's helper processes exit before the profile is removed; SIGKILL is the fallback.
  const killer = setTimeout(() => chrome.kill("SIGKILL"), 5000);
  await exited; clearTimeout(killer);
  rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
process.exit(code);
