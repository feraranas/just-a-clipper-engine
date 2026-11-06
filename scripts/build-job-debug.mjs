import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  absWorkingDir: root,
  entryPoints: ["src/job-debug/index.tsx"],
  bundle: true,
  outfile: "public/job-debug/app.js",
  minify: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  define: { "process.env.NODE_ENV": '"production"' },
});
console.log("Built local job console.");
