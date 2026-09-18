import {
  createSmoothSvgPath,
  useWindowedAudioData,
  visualizeAudioWaveform,
} from "@remotion/media-utils";
import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";

const height = 120;
const container: React.CSSProperties = {
  overflow: "visible",
  height,
  marginTop: 40,
  marginBottom: 40,
};

const OscilloscopeContainer: React.FC<{
  children?: React.ReactNode;
  padding: number;
}> = ({ children, padding }) => {
  const { width } = useVideoConfig();

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={container}
      width={width - padding * 2}
      height={height}
    >
      {children}
    </svg>
  );
};

export const Oscilloscope: React.FC<{
  audioSrc: string;
  padding: number;
  numberOfSamples: number;
  windowInSeconds: number;
  posterization: number;
  amplitude: number;
  waveColor: string;
}> = ({
  padding,
  numberOfSamples,
  windowInSeconds,
  posterization,
  amplitude,
  audioSrc,
  waveColor,
}) => {
  const { width, fps, durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();

  const posterized = Math.round(frame / posterization) * posterization;

  const { audioData, dataOffsetInSeconds } = useWindowedAudioData({
    fps,
    frame,
    src: audioSrc,
    windowInSeconds: 10,
  });

  if (!audioData) {
    return <OscilloscopeContainer padding={padding} />;
  }

  const waveform = visualizeAudioWaveform({
    fps,
    frame: posterized,
    audioData,
    numberOfSamples,
    windowInSeconds: windowInSeconds,
    channel: 0,
    dataOffsetInSeconds: dataOffsetInSeconds,
  });

  const p = createSmoothSvgPath({
    points: waveform.map((y, i) => {
      return {
        x: (i / (waveform.length - 1)) * width,
        y: height / 2 + ((y * height) / 2) * amplitude,
      };
    }),
  });

  return (
    <OscilloscopeContainer padding={padding}>
      <path
        strokeLinecap="round"
        fill="none"
        stroke={waveColor}
        strokeWidth={10}
        d={p}
      />
      <defs>
        <clipPath id="waveform-progress">
          <rect
            x={0}
            y={0}
            width={interpolate(
              frame,
              [0, durationInFrames - 1],
              [0, width],
              {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
              },
            )}
            height={height}
          />
        </clipPath>
      </defs>
      <path
        clipPath="url(#waveform-progress)"
        strokeLinecap="round"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth={10}
        d={p}
      />
    </OscilloscopeContainer>
  );
};
