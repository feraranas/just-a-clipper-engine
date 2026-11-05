import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
export async function generateNarration({
  text,
  apiKey,
  outputDir,
  fetchImpl = fetch,
  voiceId = "TX3LPaxmHKxFdv7VOQHJ",
}) {
  if (!apiKey?.trim()) throw Error("ElevenLabs key is missing");
  if (typeof text !== "string" || !text.trim() || text.length > 5000)
    throw Error("Invalid narration text");
  if (!/^[a-zA-Z0-9]+$/.test(voiceId)) throw Error("Invalid voice ID");
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const request = {
    text,
    model_id: "eleven_multilingual_v2",
    voice_settings: {
      stability: 0.35,
      similarity_boost: 0.75,
      style: 0.4,
      use_speaker_boost: true,
      speed: 1.05,
    },
  };
  try {
    await writeFile(
      join(outputDir, "request.json"),
      JSON.stringify(
        {
          voiceId,
          request,
          state: "request_started",
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
  } catch {
    throw Error(
      "Request checkpoint already exists or could not be saved; inspect before retrying",
    );
  }
  let received = false;
  try {
    const r = await fetchImpl(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(90000),
      },
    );
    if (!r.ok) {
      await writeFile(
        join(outputDir, "outcome.json"),
        JSON.stringify({ state: "http_error", status: r.status }),
        { mode: 0o600 },
      );
      received = true;
      throw Error(`ElevenLabs generation returned HTTP ${r.status}`);
    }
    const data = await r.json();
    await writeFile(join(outputDir, "response.json"), JSON.stringify(data), {
      mode: 0o600,
    });
    received = true;
    const audio = Buffer.from(data.audio_base64 ?? "", "base64");
    if (!audio.length) throw Error("Missing generated audio");
    await writeFile(join(outputDir, "narration.mp3"), audio, { mode: 0o600 });
    const a = data.normalized_alignment ?? data.alignment;
    const starts = a?.character_start_times_seconds,
      ends = a?.character_end_times_seconds;
    if (
      !a?.characters?.length ||
      !Array.isArray(starts) ||
      !Array.isArray(ends) ||
      a.characters.length !== starts.length ||
      ends.length !== starts.length ||
      !starts.every(
        (s, i) =>
          Number.isFinite(s) &&
          Number.isFinite(ends[i]) &&
          s >= 0 &&
          ends[i] >= s &&
          (!i || s >= starts[i - 1]),
      )
    )
      throw Error(
        "Invalid character timing; saved response requires inspection",
      );
    await writeFile(
      join(outputDir, "timing.json"),
      JSON.stringify({
        alignment: data.alignment,
        normalized_alignment: data.normalized_alignment,
      }),
      { mode: 0o600 },
    );
    const result = {
      state: "completed",
      voiceId,
      model: request.model_id,
      characters: text.length,
      chargedCharacters: r.headers.get("character-cost"),
      audioSha256: createHash("sha256").update(audio).digest("hex"),
      requestId: r.headers.get("request-id"),
    };
    await writeFile(
      join(outputDir, "outcome.json"),
      JSON.stringify(result, null, 2),
      { mode: 0o600 },
    );
    return result;
  } catch (e) {
    if (!received)
      await writeFile(
        join(outputDir, "outcome.json"),
        JSON.stringify({
          state: "unconfirmed",
          instruction: "Do not retry automatically",
        }),
        { mode: 0o600 },
      );
    throw e;
  }
}
