import { buildTranscriptZodSchema } from "./clip-selection-contract.mjs";

const numericUsage = (usage, field) => {
  const value = usage?.[field];
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`Invalid response usage field: ${field}`);
  return value;
};

const sanitizedUsage = (usage) => {
  if (usage === undefined || usage === null) return undefined;
  if (typeof usage !== "object" || Array.isArray(usage))
    throw new Error("Invalid response usage");
  const result = {};
  for (const field of ["input_tokens", "output_tokens", "total_tokens"]) {
    const value = numericUsage(usage, field);
    if (value !== undefined) result[field] = value;
  }
  for (const [container, field] of [
    ["input_tokens_details", "cached_tokens"],
    ["output_tokens_details", "reasoning_tokens"],
  ]) {
    const value = numericUsage(usage?.[container], field);
    if (value !== undefined) result[container] = { [field]: value };
  }
  return result;
};

export const extractStructuredOutput = (response, limits) => {
  if (!response || response.status !== "completed")
    throw new Error("Structured response is not completed");
  if (!Array.isArray(response.output))
    throw new Error("Structured response output must be an array");

  const messages = [];
  for (const item of response.output) {
    if (item?.type === "reasoning") continue;
    if (item?.type === "message") messages.push(item);
    else throw new Error(`Unsupported structured response item: ${item?.type}`);
  }
  if (messages.length !== 1)
    throw new Error("Structured response must contain exactly one message");
  const [message] = messages;
  if (
    message.status !== "completed" ||
    message.role !== "assistant" ||
    !Array.isArray(message.content)
  )
    throw new Error(
      "Structured response message is not completed assistant output",
    );
  if (message.content.some((item) => item?.type === "refusal"))
    throw new Error("Structured response contains a refusal");
  if (message.content.some((item) => item?.type !== "output_text"))
    throw new Error("Structured response contains unsupported message content");
  if (
    message.content.length !== 1 ||
    typeof message.content[0].text !== "string"
  )
    throw new Error(
      "Structured response must contain exactly one output_text item",
    );

  const text = message.content[0].text;
  if (response.output_text !== undefined && response.output_text !== text)
    throw new Error(
      "Structured response convenience text conflicts with message text",
    );
  const maximumBytes = limits?.maximumOutputTextUtf8Bytes;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new Error("Invalid output text byte limit");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maximumBytes)
    throw new Error(
      `Structured output is ${bytes} bytes and exceeds the ${maximumBytes} byte limit`,
    );

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Structured output is not valid JSON");
  }
  const parsed = buildTranscriptZodSchema(limits?.desiredClipCount).parse(json);
  return {
    responseId: response.id,
    usage: sanitizedUsage(response.usage),
    parsed,
  };
};
