import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, sha256Canonical } from "./canonical-json.mjs";

test("canonical JSON sorts nested keys without reordering arrays and hashes exact UTF-8", () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(
    sha256Canonical({ b: 2, a: 1 }),
    "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
  );
  assert.equal(
    canonicalJson({ z: [{ b: "é😀", a: 1 }, 2], a: null }),
    '{"a":null,"z":[{"a":1,"b":"é😀"},2]}',
  );
  assert.equal(
    sha256Canonical({ z: { b: 2, a: 1 } }),
    sha256Canonical({ z: { a: 1, b: 2 } }),
  );
  assert.notEqual(sha256Canonical([1, 2]), sha256Canonical([2, 1]));
  assert.equal(canonicalJson({ 10: 1, 2: 2 }), '{"10":1,"2":2}');
});

test("canonical JSON rejects silent JSON data loss and cycles", () => {
  const cycle = {};
  cycle.self = cycle;
  for (const value of [
    undefined,
    () => {},
    Symbol(),
    NaN,
    Infinity,
    -Infinity,
    1n,
    cycle,
    { a: undefined },
    [undefined],
    new Array(1),
    new Date(),
    new Map(),
    { [Symbol()]: 1 },
  ]) {
    assert.throws(() => canonicalJson(value));
  }
  const shared = { a: 1 };
  assert.equal(canonicalJson([shared, shared]), '[{"a":1},{"a":1}]');
});
