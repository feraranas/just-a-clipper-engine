import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const run = promisify(execFile);
const command = async (binary, args) =>
  (await run(binary, args, { maxBuffer: 32 * 1024 * 1024 })).stdout;
export const compareParityRecords = (baseline, candidate) => {
  if (!baseline.audioHash || !candidate.audioHash)
    return { equal: false, reason: "Audio is missing" };
  for (const field of [
    "width",
    "height",
    "fps",
    "sampleRate",
    "channels",
    "frames",
    "audioHash",
  ]) {
    if (JSON.stringify(baseline[field]) !== JSON.stringify(candidate[field]))
      return { equal: false, reason: `Mismatch: ${field}` };
  }
  if (!baseline.frames?.length)
    return { equal: false, reason: "Video frames are missing" };
  return { equal: true, reason: null };
};
export const readParityRecord = async (file) => {
  const metadata = JSON.parse(
    await command("ffprobe", [
      "-v",
      "error",
      "-show_streams",
      "-of",
      "json",
      file,
    ]),
  );
  const video = metadata.streams.find((s) => s.codec_type === "video");
  const audio = metadata.streams.find((s) => s.codec_type === "audio");
  if (!video || !audio)
    throw new Error("The fixture must contain video and audio");
  const frames = await command("ffmpeg", [
    "-v",
    "error",
    "-i",
    file,
    "-map",
    "0:v:0",
    "-an",
    "-pix_fmt",
    "rgb24",
    "-f",
    "framemd5",
    "-",
  ]);
  const audioHash = await command("ffmpeg", [
    "-v",
    "error",
    "-i",
    file,
    "-map",
    "0:a:0",
    "-vn",
    "-acodec",
    "pcm_s16le",
    "-f",
    "hash",
    "-hash",
    "sha256",
    "-",
  ]);
  return {
    width: video.width,
    height: video.height,
    fps: video.r_frame_rate,
    sampleRate: audio.sample_rate,
    channels: audio.channels,
    frames: frames
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.replace(/\s/g, "")),
    audioHash: audioHash.trim(),
  };
};
export const verifyManifest = async (manifestPath, baseline) => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const [file, expected] of Object.entries(manifest.fileHashes)) {
    const actual = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    if (actual !== expected)
      throw new Error(`Fixture or dependency changed: ${file}`);
  }
  const hash = createHash("sha256")
    .update(await readFile(baseline))
    .digest("hex");
  if (hash !== manifest.baselineSha256)
    throw new Error("Baseline file changed");
};
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        baseline: { type: "string" },
        candidate: { type: "string" },
        manifest: { type: "string" },
      },
      strict: true,
    });
    if (!values.baseline || !values.candidate || !values.manifest)
      throw new Error("Provide --baseline, --candidate and --manifest");
    await verifyManifest(values.manifest, values.baseline);
    const result = compareParityRecords(
      await readParityRecord(values.baseline),
      await readParityRecord(values.candidate),
    );
    console.log(JSON.stringify(result));
    if (!result.equal) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
