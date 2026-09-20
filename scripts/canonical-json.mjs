import { createHash } from "node:crypto";

// Encode directly: JSON.stringify reorders integer-looking object keys.
export const canonicalJson = (value) => {
  const ancestors = new Set();
  const encode = (item) => {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item))
      return JSON.stringify(item);
    if (typeof item !== "object" || item === null)
      throw new TypeError("Unsupported canonical JSON value");
    if (ancestors.has(item)) throw new TypeError("Cyclic canonical JSON value");
    if (Object.getOwnPropertySymbols(item).length)
      throw new TypeError("Symbol keys are not JSON");
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length)
          throw new TypeError("Sparse or decorated arrays are not JSON");
        return `[${Array.from(item, encode).join(",")}]`;
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item)))
        throw new TypeError("Canonical JSON requires plain objects");
      return `{${Object.keys(item)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(item[key])}`)
        .join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  return encode(value);
};

export const sha256Canonical = (value) =>
  createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");

export const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};
