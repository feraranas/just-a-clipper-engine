# OpenAI OAuth dependency provenance

This project pins and executes the installed npm artifacts directly. It does
not copy OAuth transport code into the repository and does not use the
`openai-oauth` proxy server.

## Installed artifacts

| Package              | Version  | Lockfile artifact                                                                                                                                                       | Declared repository                                                                  |
| -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `@openai-oauth/core` | `2.0.0`  | `https://registry.npmjs.org/@openai-oauth/core/-/core-2.0.0.tgz`<br>`sha512-z9NYbfS8AQjriUnM8sPjGlpR//7oFwVxqYmabraXlwUokXfsUWk4V4O60jGWOJChUvE21B1A5G0CWDazM15+8g==`   | `https://github.com/EvanZhouDev/openai-oauth.git`, directory `packages/core`         |
| `openai-oauth`       | `2.0.0`  | `https://registry.npmjs.org/openai-oauth/-/openai-oauth-2.0.0.tgz`<br>`sha512-vOu6rFBaqV9oSxOk4VNCcFJoZsE3sLfSeBn54i0s81kAa/u9vCIGKMoEpsj4jcxeL/7CsM+YCbeFpBxrCehuog==` | `https://github.com/EvanZhouDev/openai-oauth.git`, directory `packages/openai-oauth` |
| `openai`             | `6.46.0` | `https://registry.npmjs.org/openai/-/openai-6.46.0.tgz`<br>`sha512-DFg6jEPT2RO+oAyXtddeUJU8zkGy1OQ1AjGzNIJUMQG03TTqvCpy9tBpQ+2VVVnvrl3E56F8GEin2JYtWpITtA==`            | `https://github.com/openai/openai-node`                                              |

The installed package manifests and lockfile do not contain an npm `gitHead`
for these artifacts. Source equivalence to a repository commit is therefore
unproven. Runtime behavior is pinned instead by
`scripts/openai-oauth-installed-contract.test.mjs`, which uses the real
installed `createOpenAIOAuthTransport()` implementation and OpenAI SDK client.

That vertical contract verifies the pinned Codex client version, fixed backend
URLs, no npm-registry lookup, schema preservation, `store:false`, removal of
the OAuth token cap, disabled response replay expansion, reasoning-plus-message
SSE reconstruction, and rejection of refusals, tools, extra messages, extra
text items, and unknown output items.

## Application boundary

- Normal generation imports only `@openai-oauth/core`; login imports only the
  exported `runOpenAIOAuthLogin` function from `openai-oauth`.
- The application never invokes the upstream CLI, proxy handler, proxy server,
  update check, or shared Codex credential discovery.
- Credentials live in a dedicated app-owned file outside the project, with a
  verified `0700` parent and `0600` regular file. Refreshes and login promotion
  use atomic same-directory replacement.
- Network access is allowlisted to the exact HTTPS token, catalog, and
  Responses endpoints, rejects redirects, has per-operation deadlines, and
  caps every response body before upstream aggregation.
- JWT claims are unverified routing metadata only. They are not application
  authorization decisions.
- `chatgpt-oauth` is an unofficial adapter to the ChatGPT Codex backend, not
  OAuth access to `api.openai.com`, and can break when that backend changes.

The dependency installation audit reported eight low-severity findings and no
moderate, high, or critical findings. One low-severity advisory reaches the
umbrella package through AI SDK dependencies that this application does not
invoke for generation; no automatic dependency upgrade was applied.
