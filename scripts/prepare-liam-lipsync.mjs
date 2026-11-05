import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { validateMouthCues } from "../src/PresenterDemo/mouth-timing.mjs";
const { values } = parseArgs({
  options: { "audio-dir": { type: "string" }, rhubarb: { type: "string" } },
});
if (!values["audio-dir"] || !values.rhubarb)
  throw Error(
    "Supply --audio-dir and --rhubarb; this command never generates paid audio",
  );
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(values["audio-dir"]);
const request = JSON.parse(
  await readFile(join(source, "request.json"), "utf8"),
);
const outcome = JSON.parse(
  await readFile(join(source, "outcome.json"), "utf8"),
);
const bytes = await readFile(join(source, "narration.mp3"));
if (
  outcome.state !== "completed" ||
  createHash("sha256").update(bytes).digest("hex") !== outcome.audioSha256
)
  throw Error("Accepted audio fingerprint does not match");
const output = join(root, "public/generated/presenter-lipsync");
await mkdir(output, { recursive: true });
await copyFile(join(source, "narration.mp3"), join(output, "narration.mp3"));
await writeFile(join(output, "dialog.txt"), request.request.text);
execFileSync("ffmpeg", [
  "-v",
  "error",
  "-y",
  "-i",
  join(output, "narration.mp3"),
  "-ar",
  "16000",
  "-ac",
  "1",
  "-c:a",
  "pcm_s16le",
  join(output, "narration.wav"),
]);
execFileSync(
  resolve(values.rhubarb),
  [
    "-f",
    "json",
    "-d",
    join(output, "dialog.txt"),
    "-o",
    join(output, "mouth-cues.json"),
    join(output, "narration.wav"),
  ],
  { stdio: ["ignore", "ignore", "pipe"], timeout: 120000 },
);
const cues = JSON.parse(
  await readFile(join(output, "mouth-cues.json"), "utf8"),
);
const probe = JSON.parse(
  execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      join(output, "narration.wav"),
    ],
    { encoding: "utf8" },
  ),
);
const duration = Number(probe.format.duration);
validateMouthCues(cues.mouthCues, duration);
const timing = JSON.parse(await readFile(join(source, "timing.json"), "utf8"));
const a = timing.normalized_alignment ?? timing.alignment;
const words = [];
let text = "",
  start = 0,
  end = 0;
for (let i = 0; i < a.characters.length; i++) {
  const char = a.characters[i];
  if (/\s/.test(char)) {
    if (text) words.push({ text, start, end });
    text = "";
  } else {
    if (!text) start = a.character_start_times_seconds[i];
    text += char;
    end = a.character_end_times_seconds[i];
  }
}
if (text) words.push({ text, start, end });
const result = {
  voice: "Liam",
  voiceId: request.voiceId,
  audioSha256: outcome.audioSha256,
  duration,
  mouthCues: cues.mouthCues,
  words,
};
await writeFile(
  join(root, "src/PresenterDemo/liam-cues.json"),
  JSON.stringify(result, null, 2),
);
await copyFile(
  join(output, "mouth-cues.json"),
  join(source, "mouth-cues.json"),
);
console.log(
  JSON.stringify({
    duration,
    mouthCues: result.mouthCues.length,
    words: words.length,
    shapes: [...new Set(result.mouthCues.map((c) => c.value))],
  }),
);
