import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInstagramClient } from "./instagram-client.mjs";

const uri = "https://rupload.facebook.com/ig-api-upload/v26.0/123";
const make = (fetchImpl, sleep = async () => {}) => createInstagramClient({ token: "test-token", version: "v26.0", fetchImpl, sleep });
test("Facebook Login verifies both linked identity reads and rejects mismatches", async () => {
  const calls = [];
  const client = make(async (url, options) => {
    calls.push(url);
    assert.equal(new URL(url).hostname, "graph.facebook.com");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer test-token");
    assert.equal(new URL(url).searchParams.has("access_token"), false);
    return Response.json(calls.length === 1 ? { id: "1", instagram_business_account: { id: "2" } } : { id: "2", username: "theballooninquiries" });
  });
  await client.verifyAccount({ pageId: "1", accountId: "2", username: "theballooninquiries" });
  assert.equal(calls.length, 2);
  await assert.rejects(make(async () => Response.json({ id: "1", instagram_business_account: { id: "3" } })).verifyAccount({ pageId: "1", accountId: "2", username: "theballooninquiries" }), /ACCOUNT_MISMATCH/);
});
test("container creation and publication use exact form contracts and never retry POST", async () => {
  const client = make(async (url, options) => {
    assert.equal(options.method, "POST");
    const body = Object.fromEntries(options.body);
    if (url.endsWith("/media")) {
      assert.deepEqual(body, { media_type: "REELS", upload_type: "resumable", caption: "approved caption" });
      return Response.json({ id: "123", uri });
    }
    assert.deepEqual(body, { creation_id: "123" });
    return Response.json({ id: "456" });
  });
  assert.deepEqual(await client.createContainer({ accountId: "2", caption: "approved caption" }), { id: "123", uri });
  assert.deepEqual(await client.publishContainer({ accountId: "2", containerId: "123" }), { id: "456" });
  let writes = 0;
  await assert.rejects(make(async () => { writes++; throw new Error("test-token"); }).publishContainer({ accountId: "2", containerId: "123" }), (e) => e.ambiguous && !JSON.stringify(e).includes("test-token"));
  assert.equal(writes, 1);
});
test("reads retry transient failures three times, honor rate hints and stop on auth or long wait", async () => {
  for (const status of [429, 503]) {
    let calls = 0; const waits = [];
    await assert.rejects(make(async () => { calls++; return Response.json({ error: { code: 4, message: "test-token" } }, { status }); }, async (ms) => waits.push(ms)).getContainerStatus("123"));
    assert.equal(calls, 3); assert.deepEqual(waits, [1000, 2000]);
  }
  let calls = 0; const waits = [];
  const client = make(async () => ++calls === 1 ? Response.json({}, { status: 429, headers: { "retry-after": "3" } }) : Response.json({ status_code: "FINISHED" }), async (ms) => waits.push(ms));
  assert.equal((await client.getContainerStatus("123")).statusCode, "FINISHED");
  assert.deepEqual(waits, [3000]);
  for (const response of [Response.json({ error: { code: 190 } }, { status: 400 }), Response.json({}, { status: 429, headers: { "retry-after": "120" } })]) {
    calls = 0;
    await assert.rejects(make(async () => { calls++; return response; }).getContainerStatus("123"));
    assert.equal(calls, 1);
  }
});
test("malformed JSON, redirects and hostile upload URIs fail without credential leakage", async () => {
  for (const response of [new Response("test-token", { status: 200 }), new Response(null, { status: 302 })]) {
    await assert.rejects(make(async () => response).createContainer({ accountId: "2", caption: "" }), (e) => e.ambiguous && !String(e).includes("test-token"));
  }
  for (const bad of ["https://evil.test/x", uri + "?access_token=test-token", uri + "#x", uri.replace("https:", "http:"), uri.replace("facebook.com", "facebook.com:8443"), uri.replace("rupload", "user@rupload"), uri.replace("123", "999")]) {
    await assert.rejects(make(async () => Response.json({ id: "123", uri: bad })).createContainer({ accountId: "2", caption: "" }));
  }
});
test("binary uploads stream bounded chunks from the open descriptor and keep it open", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "instagram-stream-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fileHandle = await open(join(dir, "fixture.mp4"), "w+");
  t.after(() => fileHandle.close());
  const size = 16 * 1024 * 1024;
  await fileHandle.truncate(size);
  const client = make(async (url, options) => {
    assert.equal(url, uri); assert.equal(options.headers.Authorization, "OAuth test-token");
    assert.equal(options.headers.file_size, String(size)); assert.equal(options.headers.offset, "0");
    assert.equal(options.duplex, "half"); assert.equal(options.redirect, "error");
    let total = 0;
    for await (const chunk of options.body) { assert.ok(chunk.length <= 64 * 1024); total += chunk.length; }
    assert.equal(total, size);
    return Response.json({ success: true, message: "Upload successful." });
  });
  await client.uploadVideo({ uri, fileHandle, size });
  assert.equal((await fileHandle.stat()).size, size);
});
test("invalid client configuration fails before any request", () => {
  for (const options of [{ token: "", version: "v26.0" }, { token: "a\nb", version: "v26.0" }, { token: "ok", version: "../x" }]) assert.throws(() => createInstagramClient(options));
});

test("detailed status retains only safe fields including zero-byte upload errors", async () => {
  const result = await make(async (url) => {
    assert.equal(new URL(url).searchParams.get("fields"), "id,status,status_code,video_status");
    return Response.json({status_code: "IN_PROGRESS", status: "test-token", video_status: {
      uploading_phase: {status: "error", bytes_transferred: 0, source_file_size: 0,
        errors: [{code: 1363008, message: "test-token", url: "https://secret"}]},
      processing_phase: {status: "error"},
    }});
  }).getContainerStatus("123");
  assert.deepEqual(result, {statusCode: "IN_PROGRESS", uploadPhase: "error", processingPhase: "error",
    bytesTransferred: 0, sourceFileSize: 0, providerCodes: [1363008]});
});

test("missing and hostile phase fields do not imply completion or leak content", async () => {
  for (const video_status of [undefined, {uploading_phase: {status: "test-token", bytes_transferred: -1}, processing_phase: {status: "test-token"}}]) {
    const result = await make(async () => Response.json({status_code: "FINISHED", video_status})).getContainerStatus("123");
    assert.equal(result.uploadPhase, null);
    assert.equal(result.processingPhase, null);
    assert.ok(!JSON.stringify(result).includes("test-token"));
  }
});

test("timeout differs from network failure without retaining exception secrets", async () => {
  for (const [name, code] of [["TimeoutError", "REQUEST_TIMEOUT"], ["TypeError", "NETWORK_ERROR"]]) {
    await assert.rejects(make(async () => {const error = new Error("test-token"); error.name = name; throw error;})
      .publishContainer({accountId:"2", containerId:"123"}), error => {
        assert.equal(error.code, code); assert.equal(error.ambiguous, true);
        assert.ok(!JSON.stringify(error).includes("test-token")); return true;
      });
  }
});

test("timeout while reading the response body remains a timeout", async () => {
  await assert.rejects(make(async () => ({ok:true, status:200, json:async()=>{
    throw new DOMException("test-token", "TimeoutError");
  }})).publishContainer({accountId:"2",containerId:"123"}), error => {
    assert.equal(error.code,"REQUEST_TIMEOUT");
    assert.ok(!JSON.stringify(error).includes("test-token")); return true;
  });
});
