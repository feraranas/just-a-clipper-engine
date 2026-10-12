import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  classicDefaults,
  resolveTemplateSelection,
} from "../src/templates/catalog.mjs";
import {
  loadSampleRegistry,
  resolveSampleRoot,
  sha256,
} from "./template-sample-registry.mjs";
const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../", import.meta.url));
const defaultRun = (command, args) =>
  execute(command, args, { cwd: repository, maxBuffer: 8 * 1024 * 1024 });
export async function renderTemplateSample({
  sampleRoot,
  selection = {},
  run = defaultRun,
} = {}) {
  const selected = resolveTemplateSelection(selection);
  if (
    selected.selection.templateId !== "classic" ||
    selected.selection.templateVersion !== "1" ||
    selected.selection.variationId !== "default"
  )
    throw new Error("No neutral fixture exists for this selection.");
  const root = await resolveSampleRoot({ sampleRoot, projectRoot: repository });
  await mkdir(root, { recursive: true });
  const lock = join(root, ".render-lock");
  await mkdir(lock); // One writer owns generation and registry replacement.
  let stage;
  try {
    let entries = [];
    try {
      entries = await loadSampleRegistry({
        sampleRoot: root,
        projectRoot: repository,
      });
    } catch (error) {
      if (error.code !== "ENOENT" || error.path !== join(root, "registry.json"))
        throw error;
    }
    stage = await mkdtemp(join(root, ".staging-"));
    const publicDir = join(stage, "public");
    await mkdir(publicDir);
    const fixture = join(repository, "fixtures/template-samples/classic-v1");
    const content = JSON.parse(
      await readFile(join(fixture, "sample.json"), "utf8"),
    );
    await copyFile(join(fixture, "cover.svg"), join(publicDir, "cover.svg"));
    let elapsed = 0;
    const captions = [];
    const inputs = [];
    for (const [index, text] of content.sentences.entries()) {
      const audio = join(publicDir, `sentence-${index}.aiff`);
      await run("/usr/bin/say", [
        "-v",
        content.voice,
        "-r",
        String(content.wordsPerMinute),
        "-o",
        audio,
        text,
      ]);
      const { stdout } = await run("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        audio,
      ]);
      const duration = Number(stdout);
      if (!Number.isFinite(duration) || duration <= 0)
        throw new Error("Narration duration is invalid.");
      // Classic lays out individual words. Sentence boundaries are measured;
      // word timings are proportional estimates for this neutral fixture.
      const words = text.split(/\s+/);
      const weight = words.reduce((sum, word) => sum + word.length + 1, 0);
      let offset = 0;
      for (const word of words) {
        const startMs = Math.round(
          (elapsed + (duration * offset) / weight) * 1000,
        );
        offset += word.length + 1;
        captions.push({
          text: " " + word,
          startMs,
          endMs: Math.round((elapsed + (duration * offset) / weight) * 1000),
          timestampMs: startMs,
          confidence: null,
        });
      }
      elapsed += duration;
      inputs.push("-i", audio);
    }
    if (elapsed < 10 || elapsed > 15)
      throw new Error(
        `Sample duration must be 10–15 seconds; received ${elapsed.toFixed(2)}.`,
      );
    await run("ffmpeg", [
      "-v",
      "error",
      ...inputs,
      "-filter_complex",
      `concat=n=${content.sentences.length}:v=0:a=1`,
      "-ar",
      "48000",
      join(publicDir, "narration.wav"),
    ]);
    await writeFile(join(publicDir, "captions.json"), JSON.stringify(captions));
    const props = {
      ...classicDefaults,
      title: content.title,
      audioFileName: "narration.wav",
      coverImageFileName: "cover.svg",
      captionsFileName: "captions.json",
      captions: null,
    };
    const propsPath = join(stage, "props.json");
    await writeFile(propsPath, JSON.stringify(props));
    const video = join(stage, "sample.mp4");
    await run(join(repository, "node_modules/.bin/remotion"), [
      "render",
      "src/index.ts",
      selected.compositionId,
      video,
      `--props=${propsPath}`,
      `--public-dir=${publicDir}`,
      "--codec=h264",
      "--pixel-format=yuv420p",
      "--concurrency=2",
    ]);
    const { stdout } = await run("ffprobe", [
      "-v",
      "error",
      "-show_streams",
      "-show_format",
      "-of",
      "json",
      video,
    ]);
    const info = JSON.parse(stdout);
    const v = info.streams.find((s) => s.codec_type === "video");
    const a = info.streams.find((s) => s.codec_type === "audio");
    if (
      v?.codec_name !== "h264" ||
      v.width !== 1080 ||
      v.height !== 1920 ||
      !a ||
      !Number.isFinite(Number(info.format.duration)) ||
      Number(info.format.duration) < 10 ||
      Number(info.format.duration) > 15.1
    )
      throw new Error("Rendered sample failed media validation.");
    await run("ffmpeg", [
      "-v",
      "error",
      "-ss",
      "2",
      "-i",
      video,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      join(stage, "poster.jpg"),
    ]);
    const videoHash = sha256(await readFile(video));
    const posterHash = sha256(await readFile(join(stage, "poster.jpg")));
    const revision = `classic-1-default-${videoHash.slice(0, 16)}-${randomUUID()}`;
    const entry = {
      ...selected.selection,
      poster: `${revision}/poster.jpg`,
      posterHash,
      videoHash,
    };
    await writeFile(
      join(stage, "manifest.json"),
      JSON.stringify({ entry, content, captions, media: info }, null, 2) + "\n",
    );
    await rename(stage, join(root, revision));
    stage = undefined;
    // Assets exist before the atomic registry change; failures preserve the old registry.
    const retained = entries
      .filter(
        (e) =>
          !(
            e.templateId === entry.templateId &&
            e.templateVersion === entry.templateVersion &&
            e.variationId === entry.variationId
          ),
      )
      .map(
        ({
          templateId,
          templateVersion,
          variationId,
          poster,
          posterHash,
          videoHash,
          videoUrl,
        }) => ({
          templateId,
          templateVersion,
          variationId,
          poster,
          posterHash,
          videoHash,
          ...(videoUrl ? { videoUrl } : {}),
        }),
      );
    const registry = join(root, `.registry-${randomUUID()}.json`);
    await writeFile(
      registry,
      JSON.stringify(
        { contractVersion: 1, samples: [...retained, entry] },
        null,
        2,
      ) + "\n",
    );
    await rename(registry, join(root, "registry.json"));
    return {
      root,
      video: join(root, revision, "sample.mp4"),
      poster: join(root, revision, "poster.jpg"),
      duration: Number(info.format.duration),
      videoHash,
      posterHash,
    };
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.log(JSON.stringify(await renderTemplateSample(), null, 2));
  } catch (error) {
    console.error(`Sample render failed: ${error.message}`);
    process.exitCode = 1;
  }
}
