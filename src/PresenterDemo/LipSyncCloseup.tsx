import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Mouth, mouthLabels } from "./Mouth";
import { mouthAt, validateMouthCues } from "./mouth-timing.mjs";
import data from "./liam-cues.json";

const checkedCues = validateMouthCues(data.mouthCues, data.duration);

export const LipSyncCloseup: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const time = frame / fps;
  const shape = mouthAt(checkedCues, time);
  const index = data.words.findIndex((w) => time >= w.start && time < w.end);
  const wordIndex =
    index >= 0
      ? index
      : Math.max(
          0,
          data.words.findLastIndex((w) => w.start <= time),
        );
  const groupStart = Math.floor(wordIndex / 6) * 6;
  const words = data.words.slice(groupStart, groupStart + 6);
  return (
    <AbsoluteFill
      style={{
        background: "#202437",
        color: "#f7f2e7",
        fontFamily: "Arial, sans-serif",
        padding: 48,
      }}
    >
      <Audio src={staticFile("generated/presenter-lipsync/narration.mp3")} />
      <div
        style={{
          color: "#ffd078",
          letterSpacing: 4,
          fontSize: 19,
          fontWeight: 700,
        }}
      >
        LIAM / LIP-SYNC STUDY
      </div>
      <div
        style={{
          fontSize: 44,
          lineHeight: 1.1,
          fontWeight: 800,
          marginTop: 24,
        }}
      >
        Same character.
        <br />
        Sound-based mouth shapes.
      </div>
      <div
        style={{
          position: "absolute",
          left: 110,
          top: 270,
          width: 495,
          height: 650,
        }}
      >
        <div
          style={{
            width: 110,
            height: 144,
            overflow: "hidden",
            position: "relative",
            scale: 4.5,
            transformOrigin: "top left",
          }}
        >
          <Img
            src={staticFile("generated/presenter-demo/presenter-reference.png")}
            style={{
              position: "absolute",
              width: 526,
              height: 942,
              maxWidth: "none",
              left: -35,
              top: -375,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 33,
              top: 58,
              width: 28,
              height: 24,
            }}
          >
            <Mouth shape={shape} />
          </div>
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 48,
          right: 48,
          top: 950,
          textAlign: "center",
          fontSize: 29,
          lineHeight: 1.4,
          minHeight: 85,
        }}
      >
        {words.map((w, i) => (
          <span
            key={w.start + "-" + i}
            style={{
              color: groupStart + i === wordIndex ? "#ffd078" : "#f7f2e7",
            }}
          >
            {w.text}{" "}
          </span>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: 48,
          right: 48,
          bottom: 65,
          display: "flex",
          gap: 6,
          justifyContent: "center",
        }}
      >
        {Object.keys(mouthLabels).map((code) => (
          <div
            key={code}
            style={{
              width: 62,
              height: 72,
              borderRadius: 10,
              border: `2px solid ${shape === code ? "#ffd078" : "#454b66"}`,
              background: shape === code ? "#393c50" : "#272b40",
              padding: 8,
            }}
          >
            <div style={{ width: 42, height: 36 }}>
              <Mouth shape={code} patch={false} />
            </div>
            <div
              style={{
                textAlign: "center",
                fontSize: 12,
                color: shape === code ? "#ffd078" : "#afb4cc",
              }}
            >
              {code === "X" ? "REST" : code}
            </div>
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
