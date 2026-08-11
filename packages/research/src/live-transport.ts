/**
 * Live mode: a real retrieval over `fetch` (injected, never the global
 * directly — see `FetchLike` in `types.ts`). Honest timeouts — covering
 * both the header round-trip and the body read, see `readBodyCapped`
 * below — redirect following with both the requested and final URL
 * recorded, status and content-type capture, a declared user agent, and a
 * size cap enforced even when the server lies about (or omits)
 * `Content-Length`.
 *
 * **Non-2xx is refused by default.** `fetchPage` throws
 * `UnsuccessfulHttpStatusError` for any response outside the 200-299
 * range unless `LiveTransportOptions.allowNon2xx` is set. A 404 page (or
 * any other error response) must never silently become a recorded fixture
 * and, downstream, an evidence source record — see `UnsuccessfulHttpStatusError`'s
 * doc comment and `index.ts`'s "Non-2xx contract" section.
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
  UnsuccessfulHttpStatusError,
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
  /**
   * Opt into accepting non-2xx responses (404s, 500s, redirect-chain
   * failures) instead of throwing `UnsuccessfulHttpStatusError`. Off by
   * default — see the module doc's "Non-2xx is refused by default"
   * section. Only set this for callers that specifically need error
   * bodies (e.g. a link-rot checker); a normal research retrieval never
   * wants a 404 page treated as content.
   */
  readonly allowNon2xx?: boolean;
}

function pickRelevantHeaders(headers: FetchResponseLike["headers"]): HeaderMap {
  const picked: Record<string, string> = {};
  for (const name of RELEVANT_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value !== null) picked[name] = value;
  }
  return picked;
}

/**
 * Rejects the moment `signal` aborts. Used to race against `reader.read()`
 * so a slow-drip body (one that yields small chunks just often enough that
 * no single `read()` ever hangs forever, but the *overall* transfer never
 * finishes) still hits the same deadline that bounds the header fetch —
 * see `readBodyCapped` and the module doc. Does not assume the injected
 * `FetchLike`/stream actually honors `AbortSignal` itself (a hand-rolled
 * test fake need not), so this is enforced independently rather than
 * relying on the underlying stream to reject on its own.
 */
function abortSignal(signal: AbortSignal, url: string, timeoutMs: number): Promise<never> {
  if (signal.aborted) {
    return Promise.reject(new RetrievalTimeoutError(url, timeoutMs));
  }
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new RetrievalTimeoutError(url, timeoutMs)), {
      once: true,
    });
  });
}

/**
 * Reads a response body up to `maxBytes`, aborting the stream the moment
 * the cap is exceeded rather than trusting `Content-Length`.
 *
 * Also tied to `signal` for a **read deadline**: the header round-trip
 * alone completing inside `timeoutMs` is not enough — a server that sends
 * headers promptly and then drips the body one byte every few seconds
 * would otherwise stall this read loop forever, since resolving the
 * header fetch is what used to clear the timeout. Every wait on the
 * stream (or on `arrayBuffer()`, for fakes with no `body`) races against
 * the same `AbortController` the caller used for the header fetch, so the
 * two phases share one overall deadline instead of each getting their own
 * budget.
 */
async function readBodyCapped(
  response: FetchResponseLike,
  maxBytes: number,
  url: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Uint8Array> {
  if (!response.body) {
    const buffer = new Uint8Array(
      await Promise.race([response.arrayBuffer(), abortSignal(signal, url, timeoutMs)]),
    );
    if (buffer.byteLength > maxBytes) {
      throw new PayloadTooLargeError(url, maxBytes, buffer.byteLength);
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([
        reader.read(),
        abortSignal(signal, url, timeoutMs),
      ]);
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
  } catch (cause) {
    if (cause instanceof RetrievalTimeoutError) {
      await reader.cancel().catch(() => {});
    }
    throw cause;
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
    // One deadline for the whole request — header round-trip AND body
    // read. Not cleared until both phases finish (see the `finally` below):
    // clearing it the moment headers arrive would leave `readBodyCapped`
    // with no deadline of its own, letting a slow-drip body stall forever
    // (Fix 3, Wave 1 review).
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
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
      }

      // Refused by default (Fix 4, Wave 1 review): a non-2xx response
      // never becomes a `FetchedPage` unless the caller explicitly opts in
      // — see `LiveTransportOptions.allowNon2xx` and the module doc.
      if (!this.options.allowNon2xx && (response.status < 200 || response.status >= 300)) {
        throw new UnsuccessfulHttpStatusError(request.url, response.status);
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

      const bytes = await readBodyCapped(
        response,
        maxBytes,
        request.url,
        controller.signal,
        timeoutMs,
      );

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
    } finally {
      clearTimeout(timer);
    }
  }

  async search(request: SearchRequest): Promise<SearchResponse> {
    if (!this.options.search) {
      throw new LiveSearchUnavailableError(request.query);
    }
    return this.options.search.search(request, this.options.fetchImpl ?? globalThis.fetch);
  }
}
