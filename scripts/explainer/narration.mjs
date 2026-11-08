import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateNarration } from "../elevenlabs-narration.mjs";
import { scriptText } from "./contracts.mjs";
import { importNarration } from "./workflow.mjs";
export function prepareNarration(environment = process.env) {
  if (!environment.ELEVENLABS_API_KEY || !environment.AUDIOGRAM_RHUBARB_PATH)
    throw Error("Configure ElevenLabs and AUDIOGRAM_RHUBARB_PATH first");
  accessSync(environment.AUDIOGRAM_RHUBARB_PATH, constants.X_OK);
  execFileSync("ffmpeg", ["-version"], { timeout: 10000, stdio: "ignore" });
  execFileSync("ffprobe", ["-version"], { timeout: 10000, stdio: "ignore" });
  return async ({ script, folder }) => {
    const text = scriptText(script);
    await generateNarration({
      text,
      apiKey: environment.ELEVENLABS_API_KEY,
      outputDir: folder,
    });
    await writeFile(join(folder, "dialog.txt"), text, { mode: 0o600 });
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        join(folder, "narration.mp3"),
        "-ar",
        "16000",
        "-ac",
        "1",
        join(folder, "narration.wav"),
      ],
      { timeout: 30000 },
    );
    execFileSync(
      environment.AUDIOGRAM_RHUBARB_PATH,
      [
        "-f",
        "json",
        "-d",
        join(folder, "dialog.txt"),
        "-o",
        join(folder, "mouth-cues.json"),
        join(folder, "narration.wav"),
      ],
      {
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return importNarration(folder, script);
  };
}
