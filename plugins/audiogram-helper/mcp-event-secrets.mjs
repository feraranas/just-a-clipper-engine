import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHmac,
  timingSafeEqual,
  hkdfSync,
} from "node:crypto";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { EVENT_NAMES } from "./mcp-event-contract.mjs";

const invalid = () => new Error("Invalid event protection data.");
export function validateWebhookSecret(secret) {
  if (
    typeof secret !== "string" ||
    !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)
  )
    throw invalid();
  const encoded = secret.slice(6);
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length < 24 ||
    bytes.length > 64 ||
    bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")
  )
    throw invalid();
  return secret;
}
const ScopeSchema = z.strictObject({
  principalId: z.string().min(1).max(256),
  jobId: z.string().uuid(),
  name: z.enum(EVENT_NAMES),
});
const CursorSchema = ScopeSchema.extend({
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  version: z.literal(1),
});
const BoxSchema = z.strictObject({
  version: z.string(),
  iv: z.string().max(24),
  tag: z.string().max(32),
  ciphertext: z.string().max(256),
});

export function createEventSecrets({ key, keyVersion = "v1" } = {}) {
  const bytes = Buffer.isBuffer(key)
    ? Buffer.from(key)
    : typeof key === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(key)
      ? Buffer.from(key, "base64")
      : null;
  if (
    !bytes ||
    bytes.length !== 32 ||
    !/^[A-Za-z0-9_-]{1,32}$/.test(keyVersion)
  )
    throw new Error(
      "Events require a valid 32-byte protection key and key version.",
    );
  const derive = (purpose) =>
    Buffer.from(hkdfSync("sha256", bytes, "audiogram-mcp-events", purpose, 32));
  const cursorKey = derive("cursor-v1");
  const fingerprintKey = derive("fingerprint-v1");
  const mac = (data) =>
    createHmac("sha256", cursorKey).update(data).digest("base64url");
  return Object.freeze({
    sealSecret(secret) {
      validateWebhookSecret(secret);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", bytes, iv);
      cipher.setAAD(Buffer.from(`audiogram:mcp-events:secret:${keyVersion}`));
      const ciphertext = Buffer.concat([
        cipher.update(secret, "utf8"),
        cipher.final(),
      ]);
      return JSON.stringify({
        version: keyVersion,
        iv: iv.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      });
    },
    openSecret(sealed) {
      try {
        if (typeof sealed !== "string" || sealed.length > 1024) throw invalid();
        const box = BoxSchema.parse(JSON.parse(sealed));
        if (box.version !== keyVersion) throw invalid();
        const decipher = createDecipheriv(
          "aes-256-gcm",
          bytes,
          Buffer.from(box.iv, "base64url"),
        );
        decipher.setAAD(
          Buffer.from(`audiogram:mcp-events:secret:${keyVersion}`),
        );
        decipher.setAuthTag(Buffer.from(box.tag, "base64url"));
        return validateWebhookSecret(
          Buffer.concat([
            decipher.update(Buffer.from(box.ciphertext, "base64url")),
            decipher.final(),
          ]).toString("utf8"),
        );
      } catch {
        throw invalid();
      }
    },
    fingerprintSecret(secret) {
      validateWebhookSecret(secret);
      return createHmac("sha256", fingerprintKey).update(secret).digest("hex");
    },
    encodeCursor(scope) {
      const data = CursorSchema.safeParse({ ...scope, version: 1 });
      if (!data.success) throw invalid();
      const payload = JSON.stringify(data.data);
      return Buffer.from(
        JSON.stringify({ payload, signature: mac(payload) }),
      ).toString("base64url");
    },
    decodeCursor(token, scope) {
      try {
        if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,8192}$/.test(token))
          throw invalid();
        const expected = ScopeSchema.parse(scope);
        const wrapper = z
          .strictObject({
            payload: z.string().max(4096),
            signature: z.string().max(64),
          })
          .parse(JSON.parse(Buffer.from(token, "base64url").toString("utf8")));
        const actual = Buffer.from(wrapper.signature, "base64url");
        const signature = Buffer.from(mac(wrapper.payload), "base64url");
        if (
          actual.length !== signature.length ||
          !timingSafeEqual(actual, signature)
        )
          throw invalid();
        const data = CursorSchema.parse(JSON.parse(wrapper.payload));
        if (
          Object.keys(expected).some((field) => expected[field] !== data[field])
        )
          throw invalid();
        return data;
      } catch {
        throw invalid();
      }
    },
  });
}
