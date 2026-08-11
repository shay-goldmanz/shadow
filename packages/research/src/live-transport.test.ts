import { describe, expect, test } from "bun:test";
import {
  LiveSearchUnavailableError,
  PayloadTooLargeError,
  RetrievalNetworkError,
  RetrievalTimeoutError,
  UnsuccessfulHttpStatusError,
  UnsupportedContentTypeError,
} from "./errors.ts";
import { LiveTransport } from "./live-transport.ts";
import { expectRejection } from "./test-helpers.ts";
import type { FetchLike, FetchResponseLike, HeadersLike } from "./types.ts";

/**
 * A fake `fetch` — no network, ever. `live-transport.ts` never imports
 * `fetch` directly at module scope, only calls whatever is injected (or
 * the global as a last resort), so every test here supplies its own fake
 * and none of them can reach the network.
 */
function fakeHeaders(entries: Record<string, string>): HeadersLike {
  const map = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => map.get(name.toLowerCase()) ?? null };
}

function fakeResponse(
  overrides: Partial<FetchResponseLike> & { bodyText?: string },
): FetchResponseLike {
  const bodyText = overrides.bodyText ?? "<p>hello</p>";
  const bytes = new TextEncoder().encode(bodyText);
  return {
    status: overrides.status ?? 200,
    url: overrides.url ?? "https://example.com/",
    headers: overrides.headers ?? fakeHeaders({ "content-type": "text/html" }),
    body: null,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ...overrides,
  };
}

/**
 * A body stream that "drips" one chunk every `chunkDelayMs`, forever —
 * never closing. Simulates a slow-drip / stalled response body: headers
 * arrive fine, but the body itself never finishes. `cancel()` stops the
 * drip so an aborted read doesn't leave a dangling timer or throw from
 * enqueueing on a canceled controller.
 */
function slowDripStream(chunkDelayMs: number): ReadableStream<Uint8Array> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      return new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          if (!stopped) controller.enqueue(new TextEncoder().encode("x"));
          resolve();
        }, chunkDelayMs);
      });
    },
    cancel() {
      stopped = true;
      clearTimeout(timer);
    },
  });
}

describe("LiveTransport.fetchPage", () => {
  test("captures both the requested URL and the final URL after a redirect", async () => {
    const fetchImpl: FetchLike = async () =>
      fakeResponse({
        url: "https://example.com/final-destination",
        headers: fakeHeaders({ "content-type": "text/html" }),
        bodyText: "<p>Redirected content</p>",
      });
    const transport = new LiveTransport({ fetchImpl });

    const page = await transport.fetchPage({ url: "https://example.com/original" });

    expect(page.requestedUrl).toBe("https://example.com/original");
    expect(page.finalUrl).toBe("https://example.com/final-destination");
    expect(page.transport).toBe("live");
    expect(page.httpStatus).toBe(200);
    expect(new TextDecoder().decode(page.bytes)).toBe("<p>Redirected content</p>");
  });

  test("falls back to the requested URL as finalUrl when the fake fetch reports no url", async () => {
    const fetchImpl: FetchLike = async () => fakeResponse({ url: "" });
    const transport = new LiveTransport({ fetchImpl });
    const page = await transport.fetchPage({ url: "https://example.com/no-redirect" });
    expect(page.finalUrl).toBe("https://example.com/no-redirect");
  });

  test("captures status and content-type", async () => {
    const fetchImpl: FetchLike = async () =>
      fakeResponse({
        status: 200,
        headers: fakeHeaders({ "content-type": "text/html; charset=utf-8" }),
      });
    const transport = new LiveTransport({ fetchImpl });
    const page = await transport.fetchPage({ url: "https://example.com/x" });
    expect(page.httpStatus).toBe(200);
    expect(page.contentType).toBe("text/html; charset=utf-8");
  });

  test("sends a declared user agent by default", async () => {
    let sentHeaders: Record<string, string> | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      sentHeaders = init?.headers as Record<string, string>;
      return fakeResponse({});
    };
    const transport = new LiveTransport({ fetchImpl });
    await transport.fetchPage({ url: "https://example.com/x" });
    expect(sentHeaders?.["user-agent"]).toMatch(/ShadowResearchBot/);
  });

  test("a custom user agent overrides the default", async () => {
    let sentHeaders: Record<string, string> | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      sentHeaders = init?.headers as Record<string, string>;
      return fakeResponse({});
    };
    const transport = new LiveTransport({ fetchImpl, userAgent: "CustomBot/1.0" });
    await transport.fetchPage({ url: "https://example.com/x" });
    expect(sentHeaders?.["user-agent"]).toBe("CustomBot/1.0");
  });

  test("wraps a thrown fetch failure in RetrievalNetworkError", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND example.com");
    };
    const transport = new LiveTransport({ fetchImpl });
    const error = await expectRejection(
      transport.fetchPage({ url: "https://example.com/x" }),
      RetrievalNetworkError,
    );
    expect(error.url).toBe("https://example.com/x");
    expect(error.reason).toContain("ENOTFOUND");
  });

  test("a fetch that never resolves within the timeout throws RetrievalTimeoutError", async () => {
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const transport = new LiveTransport({ fetchImpl, timeoutMs: 20 });
    const error = await expectRejection(
      transport.fetchPage({ url: "https://example.com/slow" }),
      RetrievalTimeoutError,
    );
    expect(error.timeoutMs).toBe(20);
  });

  test("a body that drips chunks slower than the timeout still times out, instead of stalling forever (Fix 3)", async () => {
    // Headers arrive immediately (fine), but the body never finishes — one
    // chunk every 500ms, forever. Before Fix 3, clearing the header timer
    // the moment `fetchImpl` resolved left `readBodyCapped` with no
    // deadline of its own, so this would hang until bun:test's own
    // per-test timeout instead of failing with a clear, typed error.
    const fetchImpl: FetchLike = async () =>
      fakeResponse({
        headers: fakeHeaders({ "content-type": "text/html" }),
        body: slowDripStream(500),
      });
    const transport = new LiveTransport({ fetchImpl, timeoutMs: 20 });

    const error = await expectRejection(
      transport.fetchPage({ url: "https://example.com/slow-drip" }),
      RetrievalTimeoutError,
    );
    expect(error.timeoutMs).toBe(20);
  });

  test("a body that yields one chunk and then stalls forever times out on the same deadline", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first chunk, then nothing more"));
        // Deliberately never enqueue again and never close.
      },
    });
    const fetchImpl: FetchLike = async () =>
      fakeResponse({
        headers: fakeHeaders({ "content-type": "text/html" }),
        body: stream,
      });
    const transport = new LiveTransport({ fetchImpl, timeoutMs: 20 });

    const error = await expectRejection(
      transport.fetchPage({ url: "https://example.com/stalled-after-first-chunk" }),
      RetrievalTimeoutError,
    );
    expect(error.timeoutMs).toBe(20);
  });

  test("a non-2xx response is refused by default (Fix 4)", async () => {
    const fetchImpl: FetchLike = async () =>
      fakeResponse({ status: 404, headers: fakeHeaders({ "content-type": "text/html" }) });
    const transport = new LiveTransport({ fetchImpl });

    const error = await expectRejection(
      transport.fetchPage({ url: "https://example.com/missing" }),
      UnsuccessfulHttpStatusError,
    );
    expect(error.httpStatus).toBe(404);
    expect(error.url).toBe("https://example.com/missing");
  });

  test("a 5xx response is refused by default (Fix 4)", async () => {
    const fetchImpl: FetchLike = async () =>
      fakeResponse({ status: 503, headers: fakeHeaders({ "content-type": "text/html" }) });
    const transport = new LiveTransport({ fetchImpl });

    const error = await expectRejection(
      transport.fetchPage({ url: "https://example.com/down" }),
      UnsuccessfulHttpStatusError,
    );
    expect(error.httpStatus).toBe(503);
  });

  test("allowNon2xx opts a caller into receiving the error body instead", async () => {
    const fetchImpl: FetchLike = async () =>
      fakeResponse({
        status: 404,
        headers: fakeHeaders({ "content-type": "text/html" }),
        bodyText: "<p>Not Found</p>",
      });
    const transport = new LiveTransport({ fetchImpl, allowNon2xx: true });

    const page = await transport.fetchPage({ url: "https://example.com/missing" });
    expect(page.httpStatus).toBe(404);
    expect(new TextDecoder().decode(page.bytes)).toBe("<p>Not Found</p>");
  });

  test("2xx responses other than 200 (e.g. 201, 206) are accepted by default", async () => {
    const fetchImpl: FetchLike = async () =>
      fakeResponse({ status: 206, headers: fakeHeaders({ "content-type": "text/html" }) });
    const transport = new LiveTransport({ fetchImpl });

    const page = await transport.fetchPage({ url: "https://example.com/partial" });
    expect(page.httpStatus).toBe(206);
  });

  test("a missing content-type is rejected as unsupported", async () => {
    const fetchImpl: FetchLike = async () => fakeResponse({ headers: fakeHeaders({}) });
    const transport = new LiveTransport({ fetchImpl });
    const error = await expectRejection(
      transport.fetchPage({ url: "https://example.com/x" }),
      UnsupportedContentTypeError,
    );
    expect(error.contentType).toBeNull();
  });

  test("a disallowed content-type is rejected as unsupported", async () => {
    const fetchImpl: FetchLike = async () =>
      fakeResponse({ headers: fakeHeaders({ "content-type": "application/pdf" }) });
    const transport = new LiveTransport({ fetchImpl });
    const error = await expectRejection(
      transport.fetchPage({ url: "https://example.com/doc.pdf" }),
      UnsupportedContentTypeError,
    );
    expect(error.contentType).toBe("application/pdf");
  });

  test("a custom content-type allowlist can broaden what's accepted", async () => {
    const fetchImpl: FetchLike = async () =>
      fakeResponse({ headers: fakeHeaders({ "content-type": "application/pdf" }) });
    const transport = new LiveTransport({ fetchImpl, allowedContentTypes: ["application/pdf"] });
    const page = await transport.fetchPage({ url: "https://example.com/doc.pdf" });
    expect(page.contentType).toBe("application/pdf");
  });

  test("a declared Content-Length over the cap is rejected before reading the body", async () => {
    const fetchImpl: FetchLike = async () =>
      fakeResponse({
        headers: fakeHeaders({ "content-type": "text/html", "content-length": "999999999" }),
      });
    const transport = new LiveTransport({ fetchImpl, maxBytes: 1024 });
    const error = await expectRejection(
      transport.fetchPage({ url: "https://example.com/huge" }),
      PayloadTooLargeError,
    );
    expect(error.limitBytes).toBe(1024);
    expect(error.actualBytes).toBe(999999999);
  });

  test("a body that exceeds the cap without a Content-Length header is caught mid-stream", async () => {
    const bigChunk = new Uint8Array(2000).fill(97); // 2000 bytes, no Content-Length declared
    const fetchImpl: FetchLike = async () =>
      fakeResponse({
        headers: fakeHeaders({ "content-type": "text/html" }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(bigChunk);
            controller.close();
          },
        }),
      });
    const transport = new LiveTransport({ fetchImpl, maxBytes: 1024 });
    const error = await expectRejection(
      transport.fetchPage({ url: "https://example.com/streamed" }),
      PayloadTooLargeError,
    );
    expect(error.limitBytes).toBe(1024);
  });

  test("only a curated subset of response headers is captured", async () => {
    const fetchImpl: FetchLike = async () =>
      fakeResponse({
        headers: fakeHeaders({
          "content-type": "text/html",
          "set-cookie": "session=abc123; secret stuff",
          "x-request-id": "should-not-be-captured",
        }),
      });
    const transport = new LiveTransport({ fetchImpl });
    const page = await transport.fetchPage({ url: "https://example.com/x" });
    expect(page.headers["content-type"]).toBe("text/html");
    expect(page.headers["set-cookie"]).toBeUndefined();
    expect(page.headers["x-request-id"]).toBeUndefined();
  });
});

describe("LiveTransport.search", () => {
  test("throws LiveSearchUnavailableError when no search provider is configured", async () => {
    const transport = new LiveTransport({ fetchImpl: async () => fakeResponse({}) });
    const error = await expectRejection(
      transport.search({ query: "how linear designs its UI" }),
      LiveSearchUnavailableError,
    );
    expect(error.query).toBe("how linear designs its UI");
  });

  test("delegates to a configured search provider", async () => {
    const transport = new LiveTransport({
      fetchImpl: async () => fakeResponse({}),
      search: {
        search: async (request) => ({
          query: request.query,
          hits: [{ url: "https://linear.app/blog", title: "Linear blog" }],
          retrievedAt: "2026-08-11T09:14:22.000Z",
          transport: "live",
        }),
      },
    });
    const response = await transport.search({ query: "linear design system" });
    expect(response.hits).toHaveLength(1);
    expect(response.transport).toBe("live");
  });
});
