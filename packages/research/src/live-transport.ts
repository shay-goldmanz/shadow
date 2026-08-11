/**
 * Live mode: a real retrieval over `fetch` (injected, never the global
 * directly — see `FetchLike` in `types.ts`). Honest timeouts, redirect
 * following with both the requested and final URL recorded, status and
 * content-type capture, a declared user agent, and a size cap enforced
 * even when the server lies about (or omits) `Content-Length`.
 *
 * Search is a separate story: this package has no credentials for a live
 * search API, so `LiveTransport.search()` throws
 * `LiveSearchUnavailableError` unless a `SearchProvider` is explicitly
 * plugged in via `LiveTransportOptions.search` — nothing in this package
 * provides one. The port and the replay path are complete; only a live
 * backend is missing, and it is missing on purpose rather than papered
 * over with an invented API-key requirement.
 */

import {
  LiveSearchUnavailableError,
  PayloadTooLargeError,
  RetrievalNetworkError,
  RetrievalTimeoutError,
  UnsupportedContentTypeError,
} from "./errors.ts";
import type {
  FetchedPage,
  FetchLike,
  FetchRequest,
  FetchResponseLike,
  HeaderMap,
  RetrievalTransport,
  SearchProvider,
  SearchRequest,
  SearchResponse,
} from "./types.ts";

export const DEFAULT_USER_AGENT =
  "ShadowResearchBot/0.1 (+https://github.com/shadow-project/shadow)";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
export const DEFAULT_ALLOWED_CONTENT_TYPES: readonly string[] = [
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "application/json",
];

/** Response headers worth keeping for provenance — everything else is dropped rather than blindly captured. */
const RELEVANT_RESPONSE_HEADERS: readonly string[] = [
  "content-type",
  "content-length",
  "last-modified",
  "etag",
  "date",
];

export interface LiveTransportOptions {
  /** Injected fetch implementation. Defaults to the global `fetch` — tests should always override this. */
  readonly fetchImpl?: FetchLike;
  readonly userAgent?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Content-type prefixes (before any `;` parameters) this transport will accept. */
  readonly allowedContentTypes?: readonly string[];
  /** A live web search backend. Omit to leave `search()` unimplemented (the honest default — see module doc). */
  readonly search?: SearchProvider;
}

function pickRelevantHeaders(headers: FetchResponseLike["headers"]): HeaderMap {
  const picked: Record<string, string> = {};
  for (const name of RELEVANT_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) picked[name] = value;
  }
  return picked;
}

/** Reads a response body up to `maxBytes`, aborting the stream the moment the cap is exceeded rather than trusting `Content-Length`. */
async function readBodyCapped(
  response: FetchResponseLike,
  maxBytes: number,
  url: string,
): Promise<Uint8Array> {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new PayloadTooLargeError(url, maxBytes, buffer.byteLength);
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new PayloadTooLargeError(url, maxBytes, total);
      }
      chunks.push(value);
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export class LiveTransport implements RetrievalTransport {
  constructor(private readonly options: LiveTransportOptions = {}) {}

  async fetchPage(request: FetchRequest): Promise<FetchedPage> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = this.options.maxBytes ?? DEFAULT_MAX_BYTES;
    const allowed = this.options.allowedContentTypes ?? DEFAULT_ALLOWED_CONTENT_TYPES;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: FetchResponseLike;
    try {
      response = await fetchImpl(request.url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": this.options.userAgent ?? DEFAULT_USER_AGENT,
          accept:
            "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1",
          ...request.headers,
        },
      });
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new RetrievalTimeoutError(request.url, timeoutMs);
      }
      throw new RetrievalNetworkError(
        request.url,
        cause instanceof Error ? cause.message : String(cause),
        cause,
      );
    } finally {
      clearTimeout(timer);
    }

    const contentType = response.headers.get("content-type");
    const bareContentType = contentType?.split(";")[0]?.trim().toLowerCase() ?? null;
    if (bareContentType === null || !allowed.includes(bareContentType)) {
      throw new UnsupportedContentTypeError(request.url, contentType);
    }

    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader !== null) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new PayloadTooLargeError(request.url, maxBytes, declared);
      }
    }

    const bytes = await readBodyCapped(response, maxBytes, request.url);

    return {
      requestedUrl: request.url,
      finalUrl: response.url || request.url,
      httpStatus: response.status,
      contentType,
      headers: pickRelevantHeaders(response.headers),
      bytes,
      retrievedAt: new Date().toISOString(),
      transport: "live",
    };
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    if (!this.options.search) {
      throw new LiveSearchUnavailableError(request.query);
    }
    return this.options.search.search(request, this.options.fetchImpl ?? globalThis.fetch);
  }
}
