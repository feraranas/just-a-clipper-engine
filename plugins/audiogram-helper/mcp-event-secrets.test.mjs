import assert from "node:assert/strict";
import { test } from "node:test";
import { createDecipheriv, hkdfSync, createHmac } from "node:crypto";
import {
  createEventSecrets,
  validateWebhookSecret,
} from "./mcp-event-secrets.mjs";

const key = Buffer.alloc(32, 1);
const secret = `whsec_${Buffer.alloc(32, 2).toString("base64")}`;
const scope = {
  principalId: "owner-a",
  jobId: "11111111-1111-4111-8111-111111111111",
  name: "audiogram.job.progress",
};

test("secret protection requires an explicit key and validates signing secret bytes", () => {
  for (const invalid of [undefined, Buffer.alloc(31), "not-base64"])
    assert.throws(() => createEventSecrets({ key: invalid }));
  for (const value of [
    "private",
    "whsec_%%%",
    `whsec_${Buffer.alloc(23).toString("base64")}`,
    `whsec_${Buffer.alloc(65).toString("base64")}`,
  ]) {
    assert.throws(() => validateWebhookSecret(value));
  }
  assert.equal(validateWebhookSecret(secret), secret);
});

test("AES-256-GCM protects stored secrets with fresh nonces and authenticated versions", () => {
  const service = createEventSecrets({ key, keyVersion: "v1" });
  const sealed = service.sealSecret(secret);
  assert.equal(sealed.includes(secret), false);
  assert.notEqual(service.sealSecret(secret), sealed);
  assert.equal(service.openSecret(sealed), secret);
  const box = JSON.parse(sealed);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(box.iv, "base64url"),
  );
  decipher.setAAD(Buffer.from("audiogram:mcp-events:secret:v1"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64url"));
  assert.equal(
    Buffer.concat([
      decipher.update(Buffer.from(box.ciphertext, "base64url")),
      decipher.final(),
    ]).toString(),
    secret,
  );
  for (const changed of [
    { ...box, version: "v2" },
    { ...box, tag: Buffer.alloc(16).toString("base64url") },
  ]) {
    assert.throws(() => service.openSecret(JSON.stringify(changed)));
  }
  assert.throws(() =>
    createEventSecrets({
      key: Buffer.alloc(32, 3),
      keyVersion: "v1",
    }).openSecret(sealed),
  );
});

test("cursors authenticate scope and position with an independent purpose-separated HMAC", () => {
  const service = createEventSecrets({ key, keyVersion: "v1" });
  const token = service.encodeCursor({ ...scope, sequence: 12 });
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.equal(service.decodeCursor(token, scope).sequence, 12);
  const wrapper = JSON.parse(Buffer.from(token, "base64url").toString());
  const derived = Buffer.from(
    hkdfSync("sha256", key, "audiogram-mcp-events", "cursor-v1", 32),
  );
  const signature = createHmac("sha256", derived)
    .update(wrapper.payload)
    .digest("base64url");
  assert.equal(wrapper.signature, signature);
  wrapper.payload = wrapper.payload.replace('"sequence":12', '"sequence":99');
  assert.throws(() =>
    service.decodeCursor(
      Buffer.from(JSON.stringify(wrapper)).toString("base64url"),
      scope,
    ),
  );
  for (const changed of [
    { ...scope, principalId: "owner-b" },
    { ...scope, name: "audiogram.job.finished" },
    { ...scope, jobId: "22222222-2222-4222-8222-222222222222" },
  ]) {
    assert.throws(() => service.decodeCursor(token, changed));
  }
  assert.throws(() => service.encodeCursor({ ...scope, sequence: -1 }));
  assert.throws(() => service.decodeCursor("x".repeat(8193), scope));
});
