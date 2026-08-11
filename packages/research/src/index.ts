/**
 * @shadow/research — the retrieval transport (T2.1a).
 *
 * Live web fetching plus deterministic fixture record/replay, behind one
 * port (`RetrievalTransport`). This is deliberately narrow: it gets bytes
 * off the web (or a recorded fixture standing in for the web) and
 * normalizes them into the two digests `docs/DECISIONS.md` D16 requires.
 * It does **not** know about the evidence ledger, claims, or the model
 * package — see `docs/ARCHITECTURE.md`'s invariant for this pillar
 * ("the only pillar that may originate a source record, and only from a
 * real retrieval") and `docs/PLAN.md` T2.1b, which is the next task that
 * turns a `FetchedPage` into an evidence source record.
 *
 * ## Field mapping into `docs/EVIDENCE.md`'s source record
 *
 * This package already produces:
 *   - `retrieval.retrievedAt`   <- `FetchedPage.retrievedAt` / `SearchResponse.retrievedAt`
 *   - `retrieval.transport`     <- `FetchedPage.transport` ("live" | "fixture")
 *   - `retrieval.httpStatus`    <- `FetchedPage.httpStatus`
 *   - `retrieval.contentType`   <- `FetchedPage.contentType`
 *   - `url` / `finalUrl`        <- `FetchedPage.requestedUrl` / `.finalUrl`
 *   - `snapshot.payloadSha256`        <- `SnapshotDigests.payloadSha256`
 *   - `snapshot.normalizedTextSha256` <- `SnapshotDigests.normalizedTextSha256`
 *   - `snapshot.normalization`        <- `SnapshotDigests.normalization` ("nfc-ws-v1")
 *   - `snapshot.chars`                <- `SnapshotDigests.chars`
 *
 * T2.1b (or whatever binds this into `@shadow/evidence`) must still add:
 *   - `id` (ULID), `schemaVersion` — identity is the evidence ledger's job
 *   - `title`, `author`, `publishedAt` — not derivable from bytes alone;
 *     needs either page metadata parsing or a research-brief-level source
 *   - `retrieval.agent`, `retrieval.query` — which tool-agent and brief
 *     this retrieval served; only the caller knows that, not the transport
 *   - `snapshot.path` — where the normalized text got written as an
 *     evidence snapshot file; this package returns `normalizedText` as a
 *     string, it does not write the evidence store's `snapshots/` layout
 *   - `snapshot.archived` (optional Memento capture) — out of scope here
 *   - `authority.tier`, `authority.rationale`, `volatility` — editorial
 *     judgment, not something a transport can determine
 */

export {
  computeSnapshotDigests,
  extractMainContent,
  NORMALIZATION_ALGORITHM,
  normalizeNfcWs,
  type SnapshotDigests,
} from "./content.ts";
export type {
  CreateRetrievalTransportOptions,
  TransportMode,
} from "./create-retrieval-transport.ts";
export { createRetrievalTransport } from "./create-retrieval-transport.ts";
export {
  FixtureCorpusError,
  FixtureMissError,
  LiveSearchUnavailableError,
  PayloadTooLargeError,
  RetrievalNetworkError,
  RetrievalTimeoutError,
  ShadowResearchError,
  UnsupportedContentTypeError,
} from "./errors.ts";
export { FixtureCorpus } from "./fixture-corpus.ts";
export { formatHash, hashOf, sha256Hex } from "./hashing.ts";
export {
  DEFAULT_ALLOWED_CONTENT_TYPES,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  LiveTransport,
  type LiveTransportOptions,
} from "./live-transport.ts";
export { RecordTransport } from "./record-transport.ts";
export { ReplayTransport } from "./replay-transport.ts";
export type {
  FetchedPage,
  FetchLike,
  FetchRequest,
  FetchResponseLike,
  HeaderMap,
  HeadersLike,
  RetrievalTransport,
  SearchHit,
  SearchProvider,
  SearchRequest,
  SearchResponse,
  TransportKind,
} from "./types.ts";
