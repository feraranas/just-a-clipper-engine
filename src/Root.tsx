import "./index.css";
import { ALL_FORMATS, Input, UrlSource } from "mediabunny";
import { Composition, staticFile } from "remotion";
import { AudiogramBasic } from "./Audiogram/Main";
import { audiogramSchema } from "./Audiogram/schema";
import { getSubtitles } from "./helpers/fetch-captions";
import { FPS } from "./helpers/ms-to-frame";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="AudiogramBasic"
        component={AudiogramBasic}
        width={1080}
        height={1080}
        schema={audiogramSchema}
        defaultProps={{
          // audio settings
          audioFileName: "dialogue.wav",
          // podcast data
          title: "Ep 550 - Supper Club × Remotion React",
          coverImageFileName: "podcast-cover.jpeg",
          titleColor: "rgba(186, 186, 186, 0.93)",
          // captions settings
          captions: null,
          captionsFileName: "captions.json",
          onlyDisplayCurrentSentence: true,
          captionsTextColor: "rgba(255, 255, 255, 0.93)",
          // visualizer settings
          visualizer: {
            type: "oscilloscope",
            color: "#6B6B6B",
            numberOfSamples: "32",
            windowInSeconds: 0.1,
            posterization: 3,
            amplitude: 4,
            padding: 50,
          },
        }}
        // Determine the length of the video based on the duration of the audio file
        calculateMetadata={async ({ props }) => {
          const captions = await getSubtitles(staticFile(props.captionsFileName));
          const input = new Input({
            source: new UrlSource(staticFile(props.audioFileName)),
            formats: ALL_FORMATS,
          });

          try {
            const durationInSeconds = await input.computeDuration();
            return {
              durationInFrames: Math.ceil(durationInSeconds * FPS),
              props: {
                ...props,
                captions,
              },
              fps: FPS,
            };
          } finally {
            input.dispose();
          }
        }}
      />
    </>
  );
};
