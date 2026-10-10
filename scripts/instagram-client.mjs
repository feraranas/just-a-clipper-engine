import { setTimeout as delay } from "node:timers/promises";
import { sanitizePublishingDiagnostic } from "./publishing-diagnostics.mjs";

export class InstagramError extends Error {
  constructor(operation, code, { httpStatus = null, providerCode = null, providerSubcode = null, ambiguous = false } = {}) {
    super(`${operation}: ${code}`);
    Object.assign(this, { operation, code, httpStatus, providerCode, providerSubcode, ambiguous });
  }
}
const numericId = (value) => {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) throw new Error("Numeric Instagram ID required");
  return value;
};
export const validateUploadUri = (uri, version, id) => {
  if (typeof uri !== "string" || !/^https:\/\/rupload\.facebook\.com\/ig-api-upload\/v[0-9]+\.[0-9]+\/[0-9]+$/.test(uri)) throw new Error("Invalid Meta upload URI");
  const url = new URL(uri);
  if (version && !url.pathname.startsWith(`/ig-api-upload/${version}/`)) throw new Error("Unexpected upload version");
  if (id && !url.pathname.endsWith(`/${numericId(id)}`)) throw new Error("Unexpected upload container");
  return uri;
};

export const createInstagramClient = ({ token, version, fetchImpl = fetch, sleep = delay, timeoutMs = 120000 }) => {
  if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token)) throw new Error("Page token required without newlines");
  if (!/^v[0-9]+\.[0-9]+$/.test(version)) throw new Error("Valid Graph version required");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new Error("Bounded timeout required");
  const graph = `https://graph.facebook.com/${version}`;
  const request = async (operation, url, { method = "GET", body, headers = {}, duplex } = {}) => {
    const write = method !== "GET";
    for (let attempt = 0; attempt < (write ? 1 : 3); attempt++) {
      let response, payload;
      try {
        response = await fetchImpl(url, { method, body, headers: { Authorization: `Bearer ${token}`, ...headers }, redirect: "error", signal: AbortSignal.timeout(timeoutMs), ...(duplex ? { duplex } : {}) });
        try { payload = await response.json(); } catch (error) {
          if (error?.name === "TimeoutError") throw error;
          payload = null;
        }
      } catch (error) {
        if (!write && attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
        throw new InstagramError(operation, error?.name === "TimeoutError" ? "REQUEST_TIMEOUT" : "NETWORK_ERROR", { ambiguous: write });
      }
      const transient = response.status === 429 || response.status >= 500;
      if (!write && transient && attempt < 2) {
        const hint = response.headers.get("retry-after");
        const hintedMs = hint === null ? 0 : /^\d+$/.test(hint) ? Number(hint) * 1000 : Date.parse(hint) - Date.now();
        if (hint && (!Number.isFinite(hintedMs) || hintedMs > 60000)) throw new InstagramError(operation, "RETRY_LATER", { httpStatus: response.status });
        await sleep(Math.max(1000 * (attempt + 1), hintedMs));
        continue;
      }
      if (!response.ok || !payload || payload.error) {
        throw new InstagramError(operation, payload?.error ? "PROVIDER_ERROR" : "INVALID_RESPONSE", {
          httpStatus: response.status,
          providerCode: Number.isInteger(payload?.error?.code) ? payload.error.code : null,
          providerSubcode: Number.isInteger(payload?.error?.error_subcode) ? payload.error.error_subcode : null,
          ambiguous: write && !(response.status >= 400 && response.status < 500 && payload?.error),
        });
      }
      return payload;
    }
  };
  const post = (operation, path, fields) => request(operation, graph + path, { method: "POST", body: new URLSearchParams(fields) });
  const malformed = (operation, write = false) => new InstagramError(operation, "INVALID_RESPONSE", { ambiguous: write });
  return {
    verifyAccount: async ({ pageId, accountId, username }) => {
      numericId(pageId); numericId(accountId);
      const page = await request("verify_page", `${graph}/${pageId}?fields=id,instagram_business_account`);
      if (page.id !== pageId || page.instagram_business_account?.id !== accountId) throw new InstagramError("verify_page", "ACCOUNT_MISMATCH");
      const account = await request("verify_account", `${graph}/${accountId}?fields=id,username`);
      if (account.id !== accountId || account.username !== username) throw new InstagramError("verify_account", "ACCOUNT_MISMATCH");
      return { pageId, accountId, username };
    },
    createContainer: async ({ accountId, caption }) => {
      numericId(accountId);
      if (typeof caption !== "string") throw new Error("Caption required");
      const result = await post("create_container", `/${accountId}/media`, { media_type: "REELS", upload_type: "resumable", caption });
      try { numericId(result.id); validateUploadUri(result.uri, version, result.id); } catch { throw malformed("create_container", true); }
      return { id: result.id, uri: result.uri };
    },
    uploadVideo: async ({ uri, fileHandle, size }) => {
      validateUploadUri(uri, version);
      if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Nonempty file required");
      const body = fileHandle.createReadStream({ start: 0, end: size - 1, autoClose: false, highWaterMark: 64 * 1024 });
      try {
        const result = await request("upload_video", uri, { method: "POST", body, duplex: "half", headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(size), "content-length": String(size), "content-type": "application/octet-stream" } });
        if (result.success !== true) throw malformed("upload_video", true);
      } finally {
        // Explicit destroy closes FileHandle even with autoClose:false. Keep a
        // completed descriptor available for the worker's post-upload hash check.
        if (!body.readableEnded) body.destroy();
      }
    },
    getContainerStatus: async (containerId) => {
      const result = await request("container_status", `${graph}/${numericId(containerId)}?fields=id,status,status_code,video_status`);
      if (!["FINISHED", "IN_PROGRESS", "ERROR", "EXPIRED", "PUBLISHED"].includes(result.status_code)) throw malformed("container_status");
      const upload = result.video_status?.uploading_phase;
      const processing = result.video_status?.processing_phase;
      const detail = sanitizePublishingDiagnostic({statusCode: result.status_code,
        uploadPhase: upload?.status, processingPhase: processing?.status,
        bytesTransferred: upload?.bytes_transferred, sourceFileSize: upload?.source_file_size,
        providerCodes: [...(Array.isArray(upload?.errors) ? upload.errors : []),
          ...(Array.isArray(processing?.errors) ? processing.errors : [])].map(error => error?.code),
      });
      return {uploadPhase: null, processingPhase: null, ...detail};
    },
    publishContainer: async ({ accountId, containerId }) => {
      const result = await post("publish_container", `/${numericId(accountId)}/media_publish`, { creation_id: numericId(containerId) });
      try { numericId(result.id); } catch { throw malformed("publish_container", true); }
      return { id: result.id };
    },
    getPublishedMedia: async (mediaId) => {
      const result = await request("published_media", `${graph}/${numericId(mediaId)}?fields=id,permalink`);
      if (result.id !== mediaId || typeof result.permalink !== "string" || !/^https:\/\/www\.instagram\.com\/(reel|p)\/[A-Za-z0-9_-]+\/?$/.test(result.permalink)) throw malformed("published_media");
      return { id: result.id, permalink: result.permalink };
    },
  };
};
