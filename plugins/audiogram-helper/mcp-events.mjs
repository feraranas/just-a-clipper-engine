import { z } from "zod";
import {
  EVENT_NAMES,
  ProgressDataSchema,
  FinishedDataSchema,
} from "./mcp-event-contract.mjs";

export const eventError = (code, message, reason) =>
  Object.assign(new Error(message), {
    code,
    ...(reason ? { data: { reason } } : {}),
  });
export function requireEventPrincipal(principal) {
  if (
    !principal ||
    typeof principal.id !== "string" ||
    !principal.id ||
    principal.id.length > 256
  )
    throw eventError(-32001, "Event access denied.");
  return principal.id;
}
const argumentsSchema = z.strictObject({ job_id: z.string().uuid() });
const deliverySchema = z.strictObject({
  mode: z.literal("webhook"),
  url: z.string().max(4096),
  secret: z.string().max(128),
});
const subscribeSchema = z.strictObject({
  name: z.enum(EVENT_NAMES),
  arguments: argumentsSchema,
  delivery: deliverySchema,
  cursor: z.string().max(8192).nullable().optional(),
  ttlMs: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable()
    .optional(),
});
const unsubscribeSchema = z.strictObject({
  name: z.enum(EVENT_NAMES),
  arguments: argumentsSchema,
  delivery: deliverySchema.omit({ secret: true }),
});

export function createEventMethods({
  store,
  webhook,
  secrets,
  clock = Date.now,
  validateResult,
}) {
  const services = { webhook, secrets, clock, validateResult };
  return Object.freeze({
    async handleEventRequest({ principal, method, params = {} }) {
      requireEventPrincipal(principal);
      const input = { ...params };
      delete input._meta;
      try {
        if (method === "events/list") {
          z.strictObject({ cursor: z.string().nullable().optional() }).parse(
            input,
          );
          if (input.cursor)
            throw eventError(-32602, "Invalid event catalog cursor.");
          return {
            events: EVENT_NAMES.map((name, index) => ({
              name,
              delivery: ["webhook"],
              description:
                index === 0
                  ? "Recorded stage progress for the specified Audiogram job. Recovery stays within this attempt."
                  : "The final Audiogram job outcome, including verified artifact references and safe failures.",
              inputSchema: z.toJSONSchema(argumentsSchema),
              payloadSchema: z.toJSONSchema(
                index === 0 ? ProgressDataSchema : FinishedDataSchema,
              ),
            })),
          };
        }
        if (method === "events/subscribe") {
          const parsed = subscribeSchema.safeParse(input);
          if (!parsed.success)
            throw eventError(-32602, "Invalid event subscription.");
          return await store.subscribe({ ...parsed.data, principal }, services);
        }
        if (method === "events/unsubscribe") {
          const parsed = unsubscribeSchema.safeParse(input);
          if (!parsed.success)
            throw eventError(-32602, "Invalid event cancellation.");
          return store.unsubscribe({ ...parsed.data, principal }, services);
        }
        throw eventError(-32601, "Event method was not found.");
      } catch (error) {
        if (Number.isInteger(error.code) && error.code < 0) throw error;
        throw eventError(-32603, "Event request could not be completed.");
      }
    },
  });
}
