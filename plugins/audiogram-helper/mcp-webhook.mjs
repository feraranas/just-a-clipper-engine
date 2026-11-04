import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { randomUUID, randomBytes, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import ipaddr from "ipaddr.js";
import { Webhook } from "standardwebhooks";
import { validateWebhookSecret } from "./mcp-event-secrets.mjs";
import { EventEnvelopeSchema } from "./mcp-event-contract.mjs";

const failure = (reason) => Object.assign(new Error(reason), { reason });
export function isPublicAddress(address) {
  try {
    if (!isIP(address) || address.includes("%")) return false;
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress())
      parsed = parsed.toIPv4Address();
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}
export function validateCallbackUrl(value) {
  try {
    if (typeof value !== "string" || value.length > 4096)
      throw failure("unsafe_destination");
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !url.hostname
    )
      throw failure("unsafe_destination");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && !isPublicAddress(host))
      throw failure("unsafe_destination");
    return url;
  } catch {
    throw failure("unsafe_destination");
  }
}
function abortable(operation, signal) {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? failure("timeout"));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createPublicWebhookTransport({
  resolveAddresses = (host) => lookup(host, { all: true, verbatim: true }),
  request = httpsRequest,
} = {}) {
  return async ({ url: value, headers, body, signal }) => {
    const url = validateCallbackUrl(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await abortable(resolveAddresses(hostname), signal);
    if (
      !Array.isArray(addresses) ||
      !addresses.length ||
      addresses.some(
        ({ address, family }) =>
          !isPublicAddress(address) || isIP(address) !== family,
      )
    )
      throw failure("unsafe_destination");
    if (signal?.aborted) throw failure("timeout");
    const selected = addresses[0];
    return new Promise((resolve, reject) => {
      // No pool reuse and no second resolver call: this connection uses exactly the validated IP.
      const req = request(
        {
          protocol: "https:",
          hostname,
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method: "POST",
          headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
          agent: false,
          family: selected.family,
          autoSelectFamily: false,
          servername: isIP(hostname) ? undefined : hostname,
          rejectUnauthorized: true,
          signal,
          lookup: (_host, options, callback) =>
            options.all
              ? callback(null, [selected])
              : callback(null, selected.address, selected.family),
        },
        (response) => {
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > 16384) {
              req.destroy(failure("response_too_large"));
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          response.once("error", () => reject(failure("network_error")));
          response.once("end", () =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.once("error", (error) =>
        reject(
          failure(
            signal?.aborted ? "timeout" : (error.reason ?? "network_error"),
          ),
        ),
      );
      req.end(body);
    });
  };
}

export function createWebhookClient({
  transport = createPublicWebhookTransport(),
  clock = Date.now,
  timeoutMs = 10000,
} = {}) {
  const signedRequest = async ({
    url,
    secret,
    previousSecret,
    id,
    subscriptionId,
    body,
    signal,
  }) => {
    validateCallbackUrl(url);
    validateWebhookSecret(secret);
    const signedAt = new Date(clock());
    const signatures = [new Webhook(secret).sign(id, signedAt, body)];
    if (previousSecret)
      signatures.push(
        new Webhook(validateWebhookSecret(previousSecret)).sign(
          id,
          signedAt,
          body,
        ),
      );
    const controller = new AbortController();
    const abort = () => controller.abort(failure("timeout"));
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    try {
      return await abortable(
        transport({
          url,
          body,
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "webhook-id": id,
            "webhook-timestamp": String(Math.floor(signedAt.getTime() / 1000)),
            "webhook-signature": signatures.join(" "),
            "X-MCP-Subscription-Id": subscriptionId,
          },
        }),
        controller.signal,
      );
    } catch (error) {
      throw failure(
        controller.signal.aborted
          ? "timeout"
          : (error.reason ?? "network_error"),
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
  return Object.freeze({
    async verifyCallback({ url, secret, subscriptionId, signal }) {
      const challenge = randomBytes(32).toString("base64url");
      const response = await signedRequest({
        url,
        secret,
        subscriptionId,
        signal,
        id: `msg_verification_${randomUUID()}`,
        body: JSON.stringify({ type: "verification", challenge }),
      });
      let echo;
      try {
        echo = JSON.parse(response.body).challenge;
      } catch {
        /* Fixed safe failure below. */
      }
      if (
        response.status < 200 ||
        response.status >= 300 ||
        typeof echo !== "string"
      )
        throw failure("challenge_failed");
      const actual = Buffer.from(echo);
      const expected = Buffer.from(challenge);
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw failure("challenge_failed");
      return { verified: true };
    },
    async sendSignedEvent({ subscription, event, signal }) {
      const parsed = EventEnvelopeSchema.safeParse(event);
      if (!parsed.success) throw failure("invalid_event");
      const body = JSON.stringify(parsed.data);
      const response = await signedRequest({
        url: subscription.url,
        secret: subscription.secret,
        previousSecret: subscription.previousSecret,
        subscriptionId: subscription.id,
        id: event.eventId,
        body,
        signal,
      });
      return {
        accepted: response.status >= 200 && response.status < 300,
        httpStatus: response.status,
        ...(response.headers?.["retry-after"] !== undefined
          ? { retryAfter: response.headers["retry-after"] }
          : {}),
      };
    },
  });
}
