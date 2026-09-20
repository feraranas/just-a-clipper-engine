import assert from "node:assert/strict";
import test from "node:test";

import {
  SafeDiagnosticError,
  sanitizeErrorDiagnostic,
} from "./error-diagnostics.mjs";

test("error diagnostics redact credentials and remain deliberately bounded", () => {
  const error = new Error(
    `yt-dlp --api-key super-secret https://example.test/video?access_token=url-secret ${"x".repeat(5_000)}`,
  );
  error.stderr =
    "Authorization: Bearer bearer-secret\nrefresh_token=json-secret";

  const diagnostic = sanitizeErrorDiagnostic(error);

  assert.ok(diagnostic.length <= 2_000);
  assert.doesNotMatch(
    diagnostic,
    /super-secret|url-secret|bearer-secret|json-secret/,
  );
  assert.match(diagnostic, /\[REDACTED\]/);
  assert.match(diagnostic, /\[truncated\]$/);
});

test("redacts every supported OpenAI and OAuth secret plus auth paths", () => {
  const defaultPath =
    "/Users/example-audiogram-user/Library/Application Support/Audiogram Inbox/chatgpt-oauth/auth.json";
  const overridePath = "/private/tmp/audiogram oauth/private-auth.json";
  const diagnostic = sanitizeErrorDiagnostic(
    new Error(
      [
        "sk-basicSecret123456",
        "sk-proj-projectSecret123456",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature",
        'Authorization: {"scheme":"Bearer","credentials":"header-secret"}',
        'access_token="access-secret"',
        'refresh_token="refresh-secret"',
        'id_token="identity-secret"',
        "oauth_code=authorization-code-secret",
        defaultPath,
        overridePath,
      ].join("\n"),
    ),
    { sensitivePaths: [overridePath] },
  );

  for (const secret of [
    "basicSecret123456",
    "projectSecret123456",
    "eyJhbGciOiJIUzI1NiJ9",
    "header-secret",
    "access-secret",
    "refresh-secret",
    "identity-secret",
    "authorization-code-secret",
    defaultPath,
    overridePath,
  ])
    assert.equal(diagnostic.includes(secret), false);
  assert.match(diagnostic, /\[REDACTED\]/);
});

test("safe credential diagnostics retain only provider, stable code, and HTTP status", () => {
  for (const code of [
    "oauth_credentials_invalid",
    "oauth_credentials_permissions",
    "oauth_credentials_path",
  ]) {
    const error = new SafeDiagnosticError({
      providerId: "chatgpt-oauth",
      code,
      httpStatus: 401,
    });
    error.path = "/private/raw/auth.json";
    error.request = { headers: { authorization: "Bearer raw-secret" } };
    error.response = { body: "sk-proj-raw-response-secret" };

    assert.equal(
      sanitizeErrorDiagnostic(error),
      JSON.stringify({
        providerId: "chatgpt-oauth",
        code,
        httpStatus: 401,
      }),
    );
  }
});
