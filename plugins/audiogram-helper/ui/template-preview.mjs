import { App } from "@modelcontextprotocol/ext-apps";
import { renderTemplates } from "./template-view.mjs";
const app = new App(
  { name: "Audiogram template previews", version: "1.0.0" },
  {},
);
const status = document.getElementById("status");
app.ontoolresult = (result) =>
  renderTemplates(document, result.structuredContent, (url) =>
    app.openLink({ url }),
  );
app.onerror = () => {
  status.textContent =
    "The preview connection failed. Use the preview link in the conversation.";
};
app.connect().catch(() => {
  status.textContent =
    "Could not connect to ChatGPT. Use the preview link in the conversation.";
});
