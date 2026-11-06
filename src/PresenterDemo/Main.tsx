import React from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import legacyData from "./timing.json";
import liamTiming from "./liam-scene-timing.json";
import liamCues from "./liam-cues.json";
import { mouthAt, validateMouthCues } from "./mouth-timing.mjs";
import { LikenessPresenter } from "./LikenessPresenter";
import { OriginalMouth } from "./OriginalMouth";
const checkedLiamCues = validateMouthCues(
  liamCues.mouthCues,
  liamCues.duration,
);

const ink = "#f5f0e5",
  muted = "#b6b7ce",
  yellow = "#ffd078",
  blue = "#91b8ff",
  panel = "#2b3049";
const headings = [
  "Before the command runs",
  "Recognize a known pattern",
  "Ask about the consequence",
  "Shared history can change",
  "Your application decides",
  "A prediction is not permission",
  "Assess risk. Enforce rules.",
];
const points = [
  "Pause before execution",
  "A list only covers listed patterns",
  "What changes? Can we undo it?",
  "Flag the consequence before acting",
  "Allow · Block · Ask",
  "The classifier can be wrong",
  "Model judgment + code rules",
];
const box: React.CSSProperties = {
  background: panel,
  border: "2px solid #444a65",
  borderRadius: 22,
  padding: 28,
};

export const PresenterDemo: React.FC<{
  talking: boolean;
  liam?: boolean;
  likeness?: boolean;
}> = ({ talking, liam = false, likeness = false }) => {
  const data = liam ? liamTiming : legacyData;
  const frame = useCurrentFrame();
  const seconds = frame / data.fps;
  let index = data.segments.findIndex(
    (s) => seconds >= s.start && seconds < s.end,
  );
  if (index < 0) index = data.segments.length - 1;
  const segment = data.segments[index];
  const local = frame - Math.round(segment.start * data.fps);
  const entry = interpolate(local, [0, 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const level =
    legacyData.levels[Math.min(frame, legacyData.levels.length - 1)] ?? 0;
  return (
    <AbsoluteFill
      style={{
        background: "#202437",
        color: ink,
        fontFamily: "Arial, sans-serif",
        padding: 48,
      }}
    >
      <Audio
        src={staticFile(
          liam
            ? "generated/presenter-lipsync/narration.mp3"
            : "generated/presenter-demo/narration.wav",
        )}
      />
      <div
        style={{
          fontSize: 18,
          letterSpacing: 4,
          color: yellow,
          fontWeight: 700,
        }}
      >
        AGENT ENGINEERING / 01
      </div>
      <div
        style={{
          fontSize: 49,
          lineHeight: 1.07,
          fontWeight: 800,
          marginTop: 22,
          width: 615,
        }}
      >
        Check the consequence.
        <br />
        Then choose the action.
      </div>
      <div style={{ height: 4, background: "#41465e", marginTop: 32 }}>
        <div
          style={{
            height: 4,
            width: `${Math.min(100, (seconds / data.duration) * 100)}%`,
            background: yellow,
          }}
        />
      </div>
      <div
        style={{
          position: "absolute",
          top: 270,
          left: 48,
          right: 48,
          height: 415,
          opacity: entry,
          translate: `0 ${12 * (1 - entry)}px`,
        }}
      >
        <div
          style={{
            fontSize: 18,
            color: muted,
            marginBottom: 20,
            letterSpacing: 1,
          }}
        >
          {String(index + 1).padStart(2, "0")} / {headings[index]}
        </div>
        {index === 0 && (
          <>
            <div
              style={{
                ...box,
                fontFamily: "monospace",
                fontSize: 31,
                marginTop: 35,
              }}
            >
              <span style={{ color: yellow }}>$</span> git push --force
            </div>
            <div
              style={{
                textAlign: "center",
                fontSize: 40,
                color: blue,
                marginTop: 24,
              }}
            >
              ↓
            </div>
            <div
              style={{
                ...box,
                textAlign: "center",
                fontSize: 29,
                borderColor: yellow,
              }}
            >
              EXECUTE?
            </div>
          </>
        )}
        {index === 1 && (
          <div style={box}>
            <div style={{ fontSize: 23, color: muted, marginBottom: 24 }}>
              KNOWN PATTERNS
            </div>
            {[
              "delete important files",
              "overwrite shared work",
              "change access",
            ].map((t, i) => (
              <div
                key={t}
                style={{
                  fontSize: 28,
                  padding: "17px 0",
                  borderTop: "1px solid #444a65",
                  opacity: interpolate(local, [i * 12, i * 12 + 10], [0, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  }),
                }}
              >
                □ {t}
              </div>
            ))}
          </div>
        )}
        {index === 2 && (
          <>
            <div style={{ ...box, fontSize: 29, borderColor: blue }}>
              What will this change?
            </div>
            <div style={{ height: 24 }} />
            <div style={{ ...box, fontSize: 29, borderColor: yellow }}>
              How hard is it to undo?
            </div>
          </>
        )}
        {index === 3 && (
          <div style={{ ...box, padding: 20 }}>
            <div style={{ fontSize: 22, color: muted }}>
              SHARED BRANCH · ILLUSTRATION
            </div>
            <svg width="580" height="200" viewBox="0 0 580 200">
              <path d="M55 110 H510" stroke="#626987" strokeWidth="5" />
              {[70, 210, 350, 490].map((x, i) => (
                <g
                  key={x}
                  opacity={
                    i < 2
                      ? 1
                      : 1 -
                        interpolate(local, [30, 75], [0, 0.65], {
                          extrapolateLeft: "clamp",
                          extrapolateRight: "clamp",
                        })
                  }
                >
                  <circle
                    cx={x}
                    cy={110}
                    r="20"
                    fill={i < 2 ? blue : "#ef9b95"}
                  />
                  <text
                    x={x}
                    y="158"
                    fill={ink}
                    textAnchor="middle"
                    fontSize="20"
                  >
                    {["A", "B", "C", "D"][i]}
                  </text>
                </g>
              ))}
              <path
                d="M210 110 Q270 25 350 45 H490"
                stroke={yellow}
                strokeWidth="5"
                fill="none"
                pathLength="1"
                strokeDasharray="1"
                strokeDashoffset={
                  1 -
                  interpolate(local, [30, 75], [0, 1], {
                    extrapolateLeft: "clamp",
                    extrapolateRight: "clamp",
                  })
                }
              />
              <circle
                cx="490"
                cy="45"
                r="16"
                fill={yellow}
                opacity={interpolate(local, [65, 80], [0, 1], {
                  extrapolateLeft: "clamp",
                  extrapolateRight: "clamp",
                })}
              />
            </svg>
            <div style={{ fontSize: 25, color: yellow }}>
              A force push can lose remote commits.
            </div>
          </div>
        )}
        {index === 4 && (
          <>
            <div style={{ ...box, textAlign: "center", fontSize: 28 }}>
              RISK ASSESSMENT
            </div>
            <div
              style={{ textAlign: "center", fontSize: 34, margin: "12px 0" }}
            >
              ↓
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              {["ALLOW", "BLOCK", "ASK"].map((t, i) => (
                <div
                  key={t}
                  style={{
                    ...box,
                    padding: 22,
                    flex: 1,
                    textAlign: "center",
                    fontSize: 23,
                    color: [blue, "#ef9b95", yellow][i],
                  }}
                >
                  {t}
                </div>
              ))}
            </div>
            <div
              style={{
                fontSize: 21,
                textAlign: "center",
                marginTop: 20,
                color: muted,
              }}
            >
              These rules belong to your application.
            </div>
          </>
        )}
        {index === 5 && (
          <div style={box}>
            {[
              "Model can misjudge",
              "Limit permissions",
              "Ask before consequential actions",
            ].map((t, i) => (
              <div
                key={t}
                style={{
                  fontSize: 26,
                  padding: "20px 0",
                  color: i === 0 ? "#ef9b95" : ink,
                  borderBottom: i < 2 ? "1px solid #444a65" : undefined,
                }}
              >
                {t}
              </div>
            ))}
          </div>
        )}
        {index === 6 && (
          <>
            <div style={{ ...box, borderColor: blue, fontSize: 32 }}>
              MODEL → assess risk
            </div>
            <div style={{ height: 20 }} />
            <div style={{ ...box, borderColor: yellow, fontSize: 32 }}>
              CODE → enforce rules
            </div>
            <div style={{ marginTop: 22, fontSize: 22, color: muted }}>
              One layer in a larger safety system.
            </div>
          </>
        )}
      </div>
      {likeness ? (
        <LikenessPresenter />
      ) : liam ? (
        <div
          style={{
            position: "absolute",
            left: 22,
            top: 720,
            width: 240,
            height: 360,
          }}
        >
          <Img
            src={staticFile(
              "generated/presenter-lipsync/original-presenter.png",
            )}
            style={{ width: 240, height: 360 }}
          />
          {talking && (
            <div
              style={{
                position: "absolute",
                left: 108,
                top: 54,
                width: 19,
                height: 14,
              }}
            >
              <OriginalMouth shape={mouthAt(checkedLiamCues, seconds)} />
            </div>
          )}
        </div>
      ) : (
        <div
          style={{
            position: "absolute",
            left: 48,
            top: 735,
            width: 183,
            height: 405,
          }}
        >
          <div
            style={{
              width: 144,
              height: 321,
              overflow: "hidden",
              position: "relative",
              scale: 1.25,
              transformOrigin: "top left",
            }}
          >
            <Img
              src={staticFile(
                "generated/presenter-demo/presenter-reference.png",
              )}
              style={{
                position: "absolute",
                width: 526,
                height: 942,
                maxWidth: "none",
                left: -11,
                top: -374,
              }}
            />
            {talking && (
              <div
                style={{
                  position: "absolute",
                  left: 62,
                  top: 71,
                  width: 17,
                  height: Math.max(2, level * 14),
                  borderRadius: "40% 40% 50% 50%",
                  background: "#322824",
                  border: "1px solid #b0aaa0",
                }}
              />
            )}
          </div>
        </div>
      )}
      <div
        style={{
          position: "absolute",
          left: 265,
          top: 795,
          right: 48,
          fontSize: 38,
          fontWeight: 800,
          lineHeight: 1.17,
          color: yellow,
        }}
      >
        {points[index]}
      </div>
      <div
        style={{
          position: "absolute",
          left: 265,
          right: 48,
          top: 1020,
          color: muted,
          fontSize: 16,
        }}
      >
        {liam
          ? "ORIGINAL PRESENTER · LIAM"
          : talking
            ? "AUDIO-TIMED MOUTH · ROUGH PROTOTYPE"
            : "STATIC PRESENTER · BASELINE"}
      </div>
      <div
        style={{
          position: "absolute",
          left: 45,
          right: 45,
          bottom: 38,
          background: "#151827",
          padding: "18px 22px",
          borderRadius: 15,
          fontSize: 25,
          lineHeight: 1.25,
          textAlign: "center",
        }}
      >
        {segment.text}
      </div>
    </AbsoluteFill>
  );
};
