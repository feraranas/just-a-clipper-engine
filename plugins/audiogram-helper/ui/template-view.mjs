const MEDIA_ORIGIN = "https://media.ferarana.work";
export function safeMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === MEDIA_ORIGIN && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function renderTemplates(doc, data, openLink) {
  const root = doc.getElementById("cards");
  const status = doc.getElementById("status");
  root.replaceChildren();
  if (
    data?.contractVersion !== 1 ||
    !Array.isArray(data.templates) ||
    data.templates.some(
      (t) =>
        !t ||
        typeof t.name !== "string" ||
        typeof t.templateId !== "string" ||
        typeof t.templateVersion !== "string" ||
        !Array.isArray(t.variations) ||
        t.variations.some(
          (v) =>
            !v ||
            typeof v.variationId !== "string" ||
            typeof v.name !== "string" ||
            typeof v.description !== "string",
        ),
    )
  ) {
    status.textContent =
      "Template data is unavailable. Try listing templates again.";
    return;
  }
  status.textContent = data.templates.length
    ? "Play a sample, then tell ChatGPT which template you want."
    : "No templates are available.";
  const el = (tag, text) => {
    const node = doc.createElement(tag);
    if (text) node.textContent = text;
    return node;
  };
  for (const t of data.templates)
    for (const v of t.variations) {
      const card = el("article");
      card.append(el("h2", `${t.name} · ${v.name}`), el("p", v.description));
      const selection = el(
        "p",
        `${t.templateId} / ${t.templateVersion} / ${v.variationId}`,
      );
      selection.className = "selection";
      card.append(selection);
      const page = safeMediaUrl(v.preview?.pageUrl);
      const poster = safeMediaUrl(v.preview?.posterUrl);
      const video = safeMediaUrl(v.preview?.videoUrl);
      if (video) {
        const player = el("video");
        player.controls = true;
        player.playsInline = true;
        player.preload = "none";
        player.setAttribute("aria-label", `${t.name} sample video`);
        if (poster) player.poster = poster;
        player.src = video;
        const error = el("p");
        error.setAttribute("role", "status");
        player.addEventListener("error", () => {
          error.textContent =
            "Video could not load. Open the preview page below.";
        });
        card.append(player, error);
      } else if (poster) {
        const image = el("img");
        image.src = poster;
        image.alt = `${t.name} preview`;
        card.append(image);
      } else card.append(el("p", "No sample is available yet."));
      if (page) {
        const link = el("a", "Open preview page");
        link.href = page;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.addEventListener("click", async (event) => {
          event.preventDefault();
          try {
            const result = await openLink(page);
            if (result?.isError) throw new Error();
          } catch {
            status.textContent =
              "Could not open the page. Use the preview link in the conversation.";
          }
        });
        const links = el("p");
        links.append(link);
        card.append(links);
      }
      root.append(card);
    }
}
