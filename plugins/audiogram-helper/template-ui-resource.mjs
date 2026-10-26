import { build } from "esbuild";
import { fileURLToPath } from "node:url";
export const TEMPLATE_UI_URI = "ui://video-templates/v1.html";
export const MEDIA_ORIGIN = "https://media.ferarana.work";
export async function buildTemplateUi() {
  const result = await build({
    entryPoints: [
      fileURLToPath(new URL("./ui/template-preview.mjs", import.meta.url)),
    ],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
  });
  const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  :root{color-scheme:light dark;font:15px system-ui}body{margin:0;padding:16px}h1{font-size:20px;margin:0 0 16px}h2{font-size:17px}#cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:16px}article{border:1px solid #8886;border-radius:14px;padding:16px}video,img{display:block;width:100%;max-height:420px;object-fit:contain;background:#111;border-radius:10px}p{line-height:1.5}a{color:light-dark(#1759b5,#8cbcff)}a:focus-visible{outline:3px solid #3986ff;outline-offset:4px}.selection{font-size:12px;opacity:.75}
  </style></head><body><h1>Video templates</h1><p id="status" role="status">Loading templates…</p><main id="cards"></main><script>${js}</script></body></html>`;
}
export function registerTemplateUi(server, html) {
  server.registerResource(
    "video-templates",
    TEMPLATE_UI_URI,
    { mimeType: "text/html;profile=mcp-app" },
    async () => ({
      contents: [
        {
          uri: TEMPLATE_UI_URI,
          mimeType: "text/html;profile=mcp-app",
          text: html,
          _meta: {
            ui: {
              prefersBorder: true,
              csp: { connectDomains: [], resourceDomains: [MEDIA_ORIGIN] },
            },
            "openai/widgetDescription":
              "Video template cards with inline sample playback. Viewing does not create a job.",
            "openai/widgetCSP": {
              connect_domains: [],
              resource_domains: [MEDIA_ORIGIN],
              redirect_domains: [MEDIA_ORIGIN],
            },
            "openai/ui": { availableDisplayModes: ["inline"] },
          },
        },
      ],
    }),
  );
}
