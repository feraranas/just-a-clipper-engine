import "./index.css";
import { ALL_FORMATS, Input, UrlSource } from "mediabunny";
import { Composition, Folder, staticFile } from "remotion";
import { AudiogramBasic } from "./Audiogram/Main";
import { audiogramSchema } from "./Audiogram/schema";
import { getSubtitles } from "./helpers/fetch-captions";
import { classicDefaults, listTemplates } from "./templates/catalog.mjs";
import { FPS } from "./helpers/ms-to-frame";

export const RemotionRoot: React.FC = () => {
  return (
    <Folder name={listTemplates()[0].label}>
      <Composition
        id="AudiogramBasic"
        component={AudiogramBasic}
        width={1080}
        height={1920}
        schema={audiogramSchema}
        defaultProps={{
          // audio settings
          audioFileName: "dialogue.wav",
          // podcast data
          title: "Ep 550 - Supper Club × Remotion React",
          coverImageFileName: "podcast-cover.jpeg",
          captions: null,
          captionsFileName: "captions.json",
          ...classicDefaults,
        }}
        // Determine the length of the video based on the duration of the audio file
        calculateMetadata={async ({ props }) => {
          const captions = await getSubtitles(
            staticFile(props.captionsFileName),
          );
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
    </Folder>
  );
};
