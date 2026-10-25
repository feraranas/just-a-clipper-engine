import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTemplateSample } from "./render-template-sample.mjs";
test("a failed explicit render leaves the accepted registry unchanged", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sample-render-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = JSON.stringify({ contractVersion: 1, samples: [] });
  await writeFile(join(root, "registry.json"), original);
  let calls = 0;
  await assert.rejects(
    renderTemplateSample({
      sampleRoot: root,
      run: async () => {
        calls++;
        throw new Error("render failed");
      },
    }),
    /render failed/,
  );
  assert.equal(calls, 1);
  assert.equal(await readFile(join(root, "registry.json"), "utf8"), original);
  await assert.rejects(readFile(join(root, ".render-lock")), /ENOENT/);
});
test("invalid selection fails before invoking any local media command", async () => {
  let calls = 0;
  await assert.rejects(
    renderTemplateSample({
      selection: { templateId: "missing" },
      run: async () => {
        calls++;
      },
    }),
    /Unknown template/,
  );
  assert.equal(calls, 0);
});
test("a renderer failure after narration preserves the registry and releases the writer lock", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sample-render-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = JSON.stringify({ contractVersion: 1, samples: [] });
  await writeFile(join(root, "registry.json"), original);
  let rendered = false;
  await assert.rejects(
    renderTemplateSample({
      sampleRoot: root,
      run: async (command) => {
        if (command.endsWith("/remotion")) {
          rendered = true;
          throw new Error("renderer failed");
        }
        return { stdout: command === "ffprobe" ? "4" : "", stderr: "" };
      },
    }),
    /renderer failed/,
  );
  assert.equal(rendered, true);
  assert.equal(await readFile(join(root, "registry.json"), "utf8"), original);
  await assert.rejects(readFile(join(root, ".render-lock")), /ENOENT/);
});
test("invalid rendered duration fails validation before promotion", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sample-render-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    renderTemplateSample({
      sampleRoot: root,
      run: async (command, args) => ({
        stdout:
          command === "ffprobe"
            ? args.includes("-show_streams")
              ? JSON.stringify({
                  streams: [
                    {
                      codec_type: "video",
                      codec_name: "h264",
                      width: 1080,
                      height: 1920,
                    },
                    { codec_type: "audio" },
                  ],
                  format: { duration: "N/A" },
                })
              : "4"
            : "",
        stderr: "",
      }),
    }),
    /Rendered sample failed media validation/,
  );
  await assert.rejects(readFile(join(root, "registry.json")), /ENOENT/);
});
