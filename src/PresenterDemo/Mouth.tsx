import React from "react";
export const mouthLabels: Record<string, string> = {
  A: "Closed lips",
  B: "Teeth / narrow",
  C: "Open",
  D: "Wide vowel",
  E: "Rounded",
  F: "Puckered",
  G: "Teeth on lip",
  H: "Tongue raised",
  X: "Rest",
};
export const Mouth: React.FC<{ shape: string; patch?: boolean }> = ({
  shape,
  patch = true,
}) => {
  const stroke = "#453c32",
    fill = "#332b27",
    teeth = "#faf4df";
  return (
    <svg width="100%" height="100%" viewBox="0 0 28 24">
      {patch && <ellipse cx="14" cy="12" rx="14" ry="8" fill="#dbcdc2" />}
      {["X", "A"].includes(shape) ? (
        <path
          d={shape === "A" ? "M4 12 Q14 11 24 12" : "M5 12 Q14 15 23 12"}
          fill="none"
          stroke={stroke}
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      ) : (
        <>
          <ellipse
            cx="14"
            cy="12"
            rx={
              shape === "F" ? 4.5 : shape === "E" ? 7 : shape === "D" ? 9 : 10
            }
            ry={
              shape === "D"
                ? 9
                : shape === "B"
                  ? 3
                  : shape === "G"
                    ? 4
                    : shape === "F"
                      ? 5
                      : 6
            }
            fill={fill}
            stroke={stroke}
            strokeWidth="1"
          />
          {["B", "C", "D", "G", "H"].includes(shape) && (
            <path
              d={
                shape === "B"
                  ? "M5 10 Q14 9 23 10 L22 12 L6 12 Z"
                  : "M6 8 Q14 6 22 8 L21 10 L7 10 Z"
              }
              fill={teeth}
            />
          )}
          {["C", "D", "H"].includes(shape) && (
            <ellipse
              cx="14"
              cy={shape === "H" ? 13 : 16}
              rx={shape === "H" ? 5 : 6}
              ry={shape === "H" ? 4 : 2}
              fill="#bb7f7f"
            />
          )}
          {shape === "G" && (
            <path
              d="M5 14 Q14 18 23 14"
              fill="none"
              stroke="#bb7f7f"
              strokeWidth="2"
            />
          )}
        </>
      )}
    </svg>
  );
};
