import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateNarration } from "./elevenlabs-narration.mjs";
test("save provider audio and timing, prevent duplicate charged requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eleven-test-"));
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls++;
    assert.equal(options.headers["xi-api-key"], "private");
    return new Response(
      JSON.stringify({
        audio_base64: Buffer.from("audio").toString("base64"),
        alignment: {
          characters: ["A"],
          character_start_times_seconds: [0],
          character_end_times_seconds: [1],
        },
      }),
      { status: 200, headers: { "character-cost": "1" } },
    );
  };
  await generateNarration({
    text: "A",
    apiKey: "private",
    outputDir: dir,
    fetchImpl,
  });
  assert.equal(
    (await readFile(join(dir, "narration.mp3"))).toString(),
    "audio",
  );
  await assert.rejects(
    generateNarration({
      text: "A",
      apiKey: "private",
      outputDir: dir,
      fetchImpl,
    }),
    /checkpoint/,
  );
  assert.equal(calls, 1);
  assert.ok(
    !(await readFile(join(dir, "request.json"), "utf8")).includes("private"),
  );
});
test("malformed alignment fails with a recoverable saved response and no automatic retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eleven-bad-"));
  let calls = 0;
  await assert.rejects(
    generateNarration({
      text: "A",
      apiKey: "private",
      outputDir: dir,
      fetchImpl: async () => {
        calls++;
        return new Response(
          JSON.stringify({
            audio_base64: "YQ==",
            alignment: {
              characters: ["A"],
              character_start_times_seconds: [],
              character_end_times_seconds: [1],
            },
          }),
        );
      },
    }),
    /timing/,
  );
  assert.equal(calls, 1);
  assert.ok(await readFile(join(dir, "response.json")));
});
