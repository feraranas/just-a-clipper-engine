import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rootSource = await readFile(new URL("../src/Root.tsx", import.meta.url), "utf8");

test("AudiogramBasic is configured for Instagram 9:16 output", () => {
  assert.match(rootSource, /width=\{1080\}/);
  assert.match(rootSource, /height=\{1920\}/);
});

test("vertical composition keeps its existing treatment identity", () => {
  assert.match(rootSource, /id="AudiogramBasic"/);
});
