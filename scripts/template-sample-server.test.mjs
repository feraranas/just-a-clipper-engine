import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadSampleRegistry } from "./template-sample-registry.mjs";
import { startSampleServer } from "./template-sample-server.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");
async function fixture(t) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "sample-test-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const poster = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  await writeFile(path.join(root, "poster.jpg"), poster);
  const entry = {
    templateId: "classic",
    templateVersion: "1",
    variationId: "default",
    poster: "poster.jpg",
    posterHash: hash(poster),
    videoHash: "a".repeat(64),
  };
  const save = async (entries) =>
    writeFile(
      path.join(root, "registry.json"),
      JSON.stringify({ contractVersion: 1, samples: entries }),
    );
  await save([entry]);
  return { root, poster, entry, save };
}
test("registry rejects invalid identities, URLs, duplicates, missing or changed assets, and symlinks", async (t) => {
  const f = await fixture(t);
  for (const entries of [
    [{ ...f.entry, templateId: "missing" }],
    [f.entry, f.entry],
    [{ ...f.entry, videoUrl: "http://example.com/v.mp4" }],
    [{ ...f.entry, videoUrl: "https://user:pass@example.com/v.mp4" }],
    [{ ...f.entry, poster: "../poster.jpg" }],
    [{ ...f.entry, posterHash: "b".repeat(64) }],
  ]) {
    await f.save(entries);
    await assert.rejects(
      loadSampleRegistry({ sampleRoot: f.root, projectRoot: process.cwd() }),
    );
  }
  await f.save([f.entry]);
  await rm(path.join(f.root, "poster.jpg"));
  await assert.rejects(
    loadSampleRegistry({ sampleRoot: f.root, projectRoot: process.cwd() }),
  );
  await writeFile(path.join(f.root, "actual.jpg"), f.poster);
  await symlink("actual.jpg", path.join(f.root, "poster.jpg"));
  await assert.rejects(
    loadSampleRegistry({ sampleRoot: f.root, projectRoot: process.cwd() }),
  );
});
test("server exposes only pages/posters and handles HEAD, ETag, methods, unavailable media, and port conflict", async (t) => {
  const f = await fixture(t);
  const server = await startSampleServer({
    sampleRoot: f.root,
    projectRoot: process.cwd(),
    port: 0,
  });
  t.after(() => server.close());
  const base = server.url;
  const page = "/samples/classic/1/default/";
  assert.match(
    await (await fetch(base + page)).text(),
    /Sample video is not available yet/,
  );
  const r = await fetch(base + page + "poster.jpg");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), f.poster);
  assert.equal(
    (
      await fetch(base + page + "poster.jpg", {
        headers: { "If-None-Match": r.headers.get("etag") },
      })
    ).status,
    304,
  );
  const head = await fetch(base + page, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  for (const route of [
    "/mcp",
    "/api/items",
    "/.env",
    page + "video.mp4",
    "/samples/",
    "/samples/%2e%2e/registry.json",
  ])
    assert.equal((await fetch(base + route)).status, 404);
  assert.equal((await fetch(base + page, { method: "POST" })).status, 405);
  await assert.rejects(
    startSampleServer({
      sampleRoot: f.root,
      projectRoot: process.cwd(),
      port: server.port,
    }),
    /EADDRINUSE/,
  );
  await writeFile(path.join(f.root, "poster.jpg"), "changed");
  assert.equal((await fetch(base + page + "poster.jpg")).status, 503);
});
test("external media page uses exact origin CSP and escaped attributes without fetching remotely", async (t) => {
  const f = await fixture(t);
  await f.save([
    { ...f.entry, videoUrl: "https://example.com/video.mp4?a=1&b=2" },
  ]);
  const server = await startSampleServer({
    sampleRoot: f.root,
    projectRoot: process.cwd(),
    port: 0,
  });
  t.after(() => server.close());
  const r = await fetch(server.url + "/samples/classic/1/default/");
  const html = await r.text();
  assert.match(
    r.headers.get("content-security-policy"),
    /media-src https:\/\/example.com/,
  );
  assert.match(html, /a=1&amp;b=2/);
  assert.match(html, /playsinline/);
  assert.match(html, /could not be loaded/);
  assert.doesNotMatch(html, /autoplay/);
});
test("root validation rejects relative roots and checkout storage; another caller can use the same durable root", async (t) => {
  const f = await fixture(t);
  await assert.rejects(loadSampleRegistry({ sampleRoot: "." }), /absolute/);
  await assert.rejects(
    loadSampleRegistry({ sampleRoot: process.cwd() }),
    /outside the source checkout/,
  );
  assert.equal(
    (await loadSampleRegistry({ sampleRoot: f.root, projectRoot: "/Users" }))
      .length,
    1,
  );
});
test("revision routes, health and poster HEAD are stable; missing poster returns 503", async (t) => {
  const f = await fixture(t);
  const server = await startSampleServer({ sampleRoot: f.root, port: 0 });
  t.after(() => server.close());
  const route =
    server.url +
    "/samples/classic/1/default/poster/" +
    f.entry.posterHash +
    ".jpg";
  const r = await fetch(route, { method: "HEAD" });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "");
  assert.match(r.headers.get("cache-control"), /immutable/);
  assert.equal(r.headers.get("content-length"), String(f.poster.length));
  assert.deepEqual(await (await fetch(server.url + "/health")).json(), {
    status: "ok",
  });
  await rm(path.join(f.root, "poster.jpg"));
  assert.equal((await fetch(route)).status, 503);
  for (const port of [-1, 65536, 1.5, NaN])
    await assert.rejects(
      startSampleServer({ sampleRoot: f.root, port }),
      /integer/,
    );
});
test("sample roots inside a different Git checkout are rejected", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, ".git"), "gitdir: /not-used");
  await assert.rejects(
    loadSampleRegistry({ sampleRoot: f.root, projectRoot: process.cwd() }),
    /checkout/,
  );
});
