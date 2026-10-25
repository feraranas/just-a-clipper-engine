import assert from "node:assert/strict";
import test from "node:test";
import { renderTemplates, safeMediaUrl } from "./ui/template-view.mjs";
import { buildTemplateListing } from "./template-listing.mjs";
class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.textContent = "";
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  replaceChildren() {
    this.children = [];
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  addEventListener(name, fn) {
    this.listeners[name] = fn;
  }
}
function documentFixture() {
  const roots = { cards: new Element("main"), status: new Element("p") };
  return {
    roots,
    getElementById: (id) => roots[id],
    createElement: (tag) => new Element(tag),
  };
}
function all(node) {
  return [node, ...node.children.flatMap(all)];
}
test("renders native player with controls and opens only the validated preview", async () => {
  const doc = documentFixture();
  const opened = [];
  renderTemplates(doc, buildTemplateListing(), async (url) => {
    opened.push(url);
  });
  const nodes = all(doc.roots.cards);
  const video = nodes.find((n) => n.tag === "video");
  assert.equal(video.controls, true);
  assert.equal(video.playsInline, true);
  assert.equal(video.preload, "none");
  assert.equal(video.autoplay, undefined);
  assert.match(video.src, /demo.mp4$/);
  assert.match(video.poster, /poster.jpg$/);
  video.listeners.error();
  assert.ok(nodes.some((n) => n.textContent.includes("Video could not load")));
  await nodes
    .find((n) => n.tag === "a")
    .listeners.click({ preventDefault() {} });
  assert.deepEqual(opened, [
    "https://media.ferarana.work/templates/classic/v1/",
  ]);
});
test("rejects foreign, credentialed and script URLs", () => {
  for (const value of [
    "javascript:alert(1)",
    "https://media.ferarana.work.evil/a",
    "https://user@media.ferarana.work/a",
    "http://media.ferarana.work/a",
    undefined,
  ])
    assert.equal(safeMediaUrl(value), null);
});
test("handles malformed results, empty catalog and missing media without stale players", () => {
  const doc = documentFixture();
  for (const data of [
    null,
    {},
    { contractVersion: 1, templates: [null] },
    {
      contractVersion: 1,
      templates: [
        {
          name: "x",
          templateId: "x",
          templateVersion: "1",
          variations: [null],
        },
      ],
    },
  ]) {
    renderTemplates(doc, data, () => {});
    assert.match(doc.roots.status.textContent, /unavailable/);
  }
  renderTemplates(doc, { contractVersion: 1, templates: [] }, () => {});
  assert.match(doc.roots.status.textContent, /No templates/);
  const listing = buildTemplateListing();
  delete listing.templates[0].variations[0].preview;
  renderTemplates(doc, listing, () => {});
  assert.equal(
    all(doc.roots.cards).some((n) => n.tag === "video"),
    false,
  );
  assert.ok(
    all(doc.roots.cards).some(
      (n) => n.textContent === "No sample is available yet.",
    ),
  );
});
