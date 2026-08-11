/**
 * Shared types for the retrieval transport port.
 *
 * These are deliberately shaped to line up with `docs/EVIDENCE.md`'s
 * "Source record" schema so that T2.1b (which binds retrieval into the
 * evidence ledger) can lift fields directly rather than translating them.
 * See the package doc comment in `index.ts` for exactly which fields this
 * package produces versus which `@shadow/evidence` must still add.
 */

/**
 * How a `FetchedPage` or `SearchResponse` was obtained. Matches
 * `docs/EVIDENCE.md`'s `retrieval.transport` enum, minus `"session"` —
 * that value is for operator-transcript evidence, which this package (web
 * retrieval only) never produces.
 */
export type TransportKind = "live" | "fixture";

/** A plain header bag: lowercase header name -> value. */
export type HeaderMap = Readonly<Record<string, string>>;

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

export interface FetchRequest {
  /** The URL to fetch. Not normalized or validated here — callers decide. */
  readonly url: string;
  /** Extra request headers to send, merged over (and overridable by) the transport's defaults. */
  readonly headers?: HeaderMap;
}

/**
 * The result of one retrieval, live or replayed. This is the raw material
 * a source record is built from — see `index.ts` for the exact field
 * mapping into `docs/EVIDENCE.md`'s schema.
 */
export interface FetchedPage {
  /** The URL that was requested. */
  readonly requestedUrl: string;
  /** The URL the response actually came from, after following redirects. */
  readonly finalUrl: string;
  readonly httpStatus: number;
  /** The raw `Content-Type` response header, unparsed, or `null` if absent. */
  readonly contentType: string | null;
  /** A curated subset of response headers that matter for provenance (see `live-transport.ts`). */
  readonly headers: HeaderMap;
  /** Raw fetched bytes, exactly as received — this is what `payloadSha256` hashes. */
  readonly bytes: Uint8Array;
  /** ISO-8601 timestamp of when this retrieval happened. */
  readonly retrievedAt: string;
  readonly transport: TransportKind;
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export interface SearchRequest {
  readonly query: string;
  readonly maxResults?: number;
}

export interface SearchHit {
  readonly url: string;
  readonly title: string;
  readonly snippet?: string;
}

export interface SearchResponse {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly retrievedAt: string;
  readonly transport: TransportKind;
}

// ---------------------------------------------------------------------------
// the port
// ---------------------------------------------------------------------------

/**
 * The retrieval transport port. Callers (T2.1b's tool-agents) depend on
 * this interface only — never on `LiveTransport`, `ReplayTransport`, or
 * `RecordTransport` directly. The mode is chosen once, at construction, by
 * whoever wires the dependency (see `create-retrieval-transport.ts`); no
 * code behind this interface sniffs `NODE_ENV` or any other ambient state
 * to decide how to behave.
 */
export interface RetrievalTransport {
  fetchPage(request: FetchRequest): Promise<FetchedPage>;
  search(request: SearchRequest): Promise<SearchResponse>;
}

// ---------------------------------------------------------------------------
// injectable fetch, so live-path behavior is testable with no network
// ---------------------------------------------------------------------------

/** The subset of `Headers` we actually use — real `Headers` satisfies this structurally. */
export interface HeadersLike {
  get(name: string): string | null;
}

/**
 * The subset of the global `Response` we actually use. Deliberately not
 * `Response` itself: the DOM `Response` constructor cannot set a custom
 * `.url` (it is populated by the runtime's fetch implementation from the
 * final redirect hop), which makes it impossible to construct a fake
 * `Response` for redirect tests. This narrower shape can be faked freely.
 * The real global `fetch` satisfies it structurally, so nothing is lost.
 */
export interface FetchResponseLike {
  readonly status: number;
  /** The final URL after following redirects (what real `fetch` sets on `Response#url`). */
  readonly url: string;
  readonly headers: HeadersLike;
  readonly body: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<FetchResponseLike>;

/**
 * A pluggable live search backend. Nothing in this package implements one
 * (see `LiveSearchUnavailableError`) — this exists so a real backend can be
 * wired in later without changing the port or the replay/record paths.
 */
export interface SearchProvider {
  search(request: SearchRequest, fetchImpl: FetchLike): Promise<SearchResponse>;
}
