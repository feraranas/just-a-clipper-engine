import { createHash } from "node:crypto";
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const style = `body{margin:0;background:#10141e;color:#f4f6fb;font-family:system-ui,sans-serif}main{max-width:840px;margin:40px auto;padding:24px}header{margin-bottom:24px}.badge{color:#a6c5ff;font-size:14px}h1{font-size:32px;margin:8px 0}p{line-height:1.6;color:#bfc9db}figure{margin:0}img,video{display:block;width:100%;max-width:360px;border-radius:16px;background:#1c2333}section{display:flex;gap:32px;align-items:flex-start}.note{max-width:360px}a{color:#a6c5ff}@media(max-width:600px){section{flex-direction:column}main{margin:12px auto}}`;
const script = `const video=document.querySelector('video');if(video)video.addEventListener('error',()=>{document.getElementById('playback-error').hidden=false;});`;
const hash = (s) => createHash("sha256").update(s).digest("base64");
export function samplePage(entry) {
  const poster = escape(entry.basePath + "poster/" + entry.posterHash + ".jpg");
  const media = entry.videoUrl
    ? `<video controls playsinline preload="none" poster="${poster}" src="${escape(entry.videoUrl)}" aria-label="${escape(entry.name)} demonstration"></video><p id="playback-error" role="status" hidden>The sample video could not be loaded. Please try again later.</p>`
    : `<img src="${poster}" alt="${escape(entry.name)} demonstration poster"><p role="status">Sample video is not available yet.</p>`;
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(entry.name)} sample</title><style>${style}</style><main><header><span class="badge">TEMPLATE DEMONSTRATION</span><h1>${escape(entry.name)}</h1><p>${escape(entry.description)}</p></header><section><figure>${media}</figure><div class="note"><h2>Default variation</h2><p>This is neutral demonstration content. Your video will use your own title, artwork, and transcript.</p><p>Viewing this sample does not start a job.</p></div></section></main><script>${script}</script></html>`;
  const csp = `default-src 'none'; img-src 'self'; style-src 'sha256-${hash(style)}'; script-src 'sha256-${hash(script)}'; media-src ${entry.videoUrl ? new URL(entry.videoUrl).origin : "'none'"}; base-uri 'none'; frame-ancestors 'none'`;
  return { html, csp };
}
