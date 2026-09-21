import { SafeDiagnosticError } from "./error-diagnostics.mjs";

const fail = (code) =>
  new SafeDiagnosticError({ providerId: "chatgpt-oauth", code });
const defaultScheduler = { setTimeout, clearTimeout };
const operationFor = (input) => {
  let url;
  try {
    url = new URL(input instanceof Request ? input.url : String(input));
  } catch {
    throw fail("oauth_url_forbidden");
  }
  if (url.username || url.password || url.hash)
    throw fail("oauth_url_forbidden");
  if (
    url.origin === "https://auth.openai.com" &&
    url.pathname === "/oauth/token" &&
    !url.search
  )
    return {
      url,
      ms: 30_000,
      code: "oauth_refresh_timeout",
      maxBytes: 262_144,
    };
  if (
    url.origin === "https://chatgpt.com" &&
    url.pathname === "/backend-api/codex/models"
  )
    return {
      url,
      ms: 30_000,
      code: "oauth_catalog_timeout",
      maxBytes: 2 * 1024 * 1024,
    };
  if (
    url.origin === "https://chatgpt.com" &&
    url.pathname === "/backend-api/codex/responses" &&
    !url.search
  )
    return {
      url,
      ms: 120_000,
      code: "oauth_responses_timeout",
      maxBytes: 2 * 1024 * 1024,
    };
  throw fail("oauth_url_forbidden");
};

// One wrapper per operation owner: a fatal error stays latched even if core
// swallows catalog failures, so no subsequent network call can hide it.
export const createBoundedAllowlistedFetch = ({
  fetch: upstream = globalThis.fetch,
  scheduler = defaultScheduler,
  signal,
  onError = () => {},
} = {}) => {
  let fatal;
  const remember = (error) => {
    fatal ??= error;
    onError(fatal);
    return fatal;
  };
  return async (input, init = {}) => {
    if (fatal) throw fatal;
    let operation;
    try {
      operation = operationFor(input);
    } catch (error) {
      throw remember(error);
    }
    const controller = new AbortController();
    const signals = [
      ...new Set(
        [
          signal,
          init.signal ?? (input instanceof Request ? input.signal : undefined),
        ].filter(Boolean),
      ),
    ];
    let reader,
      bodyController,
      finished = false,
      deadline,
      rejectAbort;
    const aborted = new Promise((_, reject) => {
      rejectAbort = reject;
    });
    // A body consumer may start after the deadline has already fired.
    aborted.catch(() => {});
    const cleanup = () => {
      scheduler.clearTimeout(deadline);
      for (const source of signals)
        source.removeEventListener("abort", cancelFromCaller);
    };
    const stop = (error) => {
      if (finished) return;
      finished = true;
      remember(error);
      controller.abort(error);
      rejectAbort(error);
      bodyController?.error(error);
      void reader?.cancel(error).catch(() => {});
      cleanup();
    };
    const cancelFromCaller = () => stop(fail("oauth_request_aborted"));
    deadline = scheduler.setTimeout(
      () => stop(fail(operation.code)),
      operation.ms,
    );
    for (const source of signals) {
      source.addEventListener("abort", cancelFromCaller, { once: true });
      if (source.aborted) cancelFromCaller();
    }
    try {
      if (finished) throw fatal;
      const pending = Promise.resolve(
        upstream(input, {
          ...init,
          redirect: "error",
          signal: controller.signal,
        }),
      );
      // Clean up a late response from a fetch implementation that ignores abort.
      pending.then(
        (response) => {
          if (finished) void response.body?.cancel().catch(() => {});
        },
        () => {},
      );
      const response = await Promise.race([pending, aborted]);
      reader = response.body?.getReader();
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400) ||
        (response.url && response.url !== operation.url.href)
      )
        throw fail("oauth_redirect_forbidden");
      if (!reader) {
        finished = true;
        cleanup();
        return response;
      }
      let bytes = 0;
      const body = new ReadableStream({
        start(c) {
          bodyController = c;
        },
        async pull(c) {
          try {
            const { done, value } = await Promise.race([
              reader.read(),
              aborted,
            ]);
            if (finished) return;
            if (done) {
              finished = true;
              cleanup();
              c.close();
              return;
            }
            bytes += value.byteLength;
            if (bytes > operation.maxBytes) {
              stop(fail("oauth_response_too_large"));
              return;
            }
            c.enqueue(value);
          } catch (error) {
            stop(
              error instanceof SafeDiagnosticError
                ? error
                : fail("oauth_request_failed"),
            );
          }
        },
        cancel() {
          finished = true;
          controller.abort();
          cleanup();
          return reader.cancel();
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      const safe =
        error instanceof SafeDiagnosticError
          ? error
          : fail("oauth_request_failed");
      stop(safe);
      throw fatal ?? safe;
    }
  };
};
