/**
 * @shadow/research — the retrieval transport (T2.1a).
 *
 * Live web fetching plus deterministic fixture record/replay, behind one
 * port (`RetrievalTransport`). This is deliberately narrow: it gets bytes
 * off the web (or a recorded fixture standing in for the web) and extracts
 * main content from HTML (`extractMainContent`) — the one part of
 * `nfc-ws-v1` that needs an HTML parser and so belongs to the transport
 * (`docs/EVIDENCE.md` amendment 4). It does **not** know about the
 * evidence ledger, claims, or the model package — see
 * `docs/ARCHITECTURE.md`'s invariant for this pillar ("the only pillar
 * that may originate a source record, and only from a real retrieval")
 * and `docs/PLAN.md` T2.1b, which is the next task that turns a
 * `FetchedPage` into an evidence source record.
 *
 * **Live search.** `LiveTransport.search()` needs a `SearchProvider`
 * (`LiveTransportOptions.search`) to do anything — this package ships one,
 * `AgenticSearchProvider` (`agentic-search-provider.ts`), backed by
 * `@shadow/model`'s agentic session port running Claude Code's built-in
 * `WebSearch` on the operator's subscription (D5), since there is no
 * search-provider API key to use instead (`docs/ACCEPTANCE.md`). It is a
 * distinct, narrow session from `WebResearchToolAgent`'s own — see that
 * class's doc for why the two must never share a session, and
 * `agentic-search-provider.ts`'s doc for the full design. For the `bedrock`
 * model provider (D26), which has no Claude Code `WebSearch` tool to back
 * that session, `UnavailableSearchProvider` (`unavailable-search-provider.ts`)
 * is wired in instead — it always rejects with `SearchUnavailableError`, a
 * clean, operator-actionable failure rather than a confused model turn.
 *
 * **Normalization and digests are `@shadow/evidence`'s, not ours.** Steps
 * 2-5 of `nfc-ws-v1` (`normalizeNfcWs`, `computeSnapshotDigests`,
 * `SnapshotDigests`, `NORMALIZATION_ALGORITHM`) are owned exclusively by
 * `@shadow/evidence`, which this package depends on and imports from
 * directly — they are **not** re-exported here. This is deliberate: two
 * packages independently exporting an identically-named
 * `computeSnapshotDigests` is exactly the drift-and-collision hazard this
 * dependency exists to close. T2.1b should do
 * `extractMainContent` from `@shadow/research` and
 * `normalizeNfcWs`/`computeSnapshotDigests` from `@shadow/evidence` — two
 * distinct imports, no aliasing needed.
 *
 * ## Field mapping into `docs/EVIDENCE.md`'s source record
 *
 * This package already produces:
 *   - `retrieval.retrievedAt`   <- `FetchedPage.retrievedAt` / `SearchResponse.retrievedAt`
 *   - `retrieval.transport`     <- `FetchedPage.transport` ("live" | "fixture")
 *   - `retrieval.httpStatus`    <- `FetchedPage.httpStatus` (2xx only by default — see `LiveTransportOptions.allowNon2xx`)
 *   - `retrieval.contentType`   <- `FetchedPage.contentType`
 *   - `url` / `finalUrl`        <- `FetchedPage.requestedUrl` / `.finalUrl`
 *
 * Combined with `@shadow/evidence`'s `computeSnapshotDigests(bytes,
 * extractMainContent(html))`:
 *   - `snapshot.payloadSha256`        <- `SnapshotDigests.payloadSha256`
 *   - `snapshot.normalizedTextSha256` <- `SnapshotDigests.normalizedTextSha256`
 *   - `snapshot.normalization`        <- `NORMALIZATION_ALGORITHM` ("nfc-ws-v1")
 *   - `snapshot.chars`                <- `SnapshotDigests.chars`
 *
 * ## T2.1b — the research brief port and tool-agents
 *
 * `brief.ts` defines `ResearchBriefPort`, the seam `@shadow/agent` (Shadow,
 * T3.3) depends on: give it a `ResearchBrief`, get back a `ResearchResult`
 * whose `findings` are already bound to `sources` written into the
 * evidence ledger. `WebResearchToolAgent` (`web-research-tool-agent.ts`) is
 * the reference implementation — an `@shadow/model` agentic session armed
 * with exactly three custom tools (`retrieval-tools.ts`:
 * `search`/`fetch`/`submit_findings`), each a closure over this package's
 * `RetrievalTransport` and `@shadow/evidence`'s `EvidenceStore`. See
 * `web-research-tool-agent.ts`'s module doc for how that makes reaching the
 * network any other way structurally hard, not just discouraged.
 *
 * `transcript-source.ts`'s `recordSessionTranscriptSource` is the *other*
 * legitimate origin of a source record (D19/D23) — a session transcript,
 * for `@shadow/agent` to cite when recording what the operator actually
 * said.
 *
 * The gaps T2.1a's own doc comment (below) lists are exactly what
 * `retrieval-tools.ts`'s `fetch` tool closes, by calling
 * `EvidenceStore.putSourceFromRetrieval` itself:
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
 *
 * **Non-2xx contract.** `LiveTransport.fetchPage` refuses non-2xx
 * responses by default, throwing `UnsuccessfulHttpStatusError` — a 404 or
 * 500 error page never becomes a `FetchedPage`, so it can never be
 * recorded as a fixture or promoted to a source record by accident. A
 * caller that genuinely wants the error body (e.g. a link-rot checker)
 * must opt in with `LiveTransportOptions.allowNon2xx: true`, in which case
 * `FetchedPage.httpStatus` may be anything and T2.1b is responsible for
 * checking it before calling `putSource`.
 */

export type {
  AgenticSearchProviderDeps,
  SearchProviderSessionTuning,
} from "./agentic-search-provider.ts";
export {
  AgenticSearchProvider,
  DEFAULT_SEARCH_MAX_RESULTS,
  parseSearchResults,
} from "./agentic-search-provider.ts";
export type {
  Citation,
  Finding,
  ResearchBrief,
  ResearchBriefPort,
  ResearchResult,
} from "./brief.ts";
export { extractMainContent } from "./content.ts";
export type {
  CreateRetrievalTransportOptions,
  TransportMode,
} from "./create-retrieval-transport.ts";
export { createRetrievalTransport } from "./create-retrieval-transport.ts";
export {
  FixtureCorpusError,
  FixtureMissError,
  LiveSearchUnavailableError,
  NoFindingsProducedError,
  PayloadTooLargeError,
  ResearchAgentBusyError,
  ResearchTurnFailedError,
  RetrievalNetworkError,
  RetrievalTimeoutError,
  SearchResultParseError,
  SearchSessionTurnFailedError,
  SearchUnavailableError,
  ShadowResearchError,
  SourceBudgetExceededError,
  UnboundCitationError,
  UnsuccessfulHttpStatusError,
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
export type { FetchedSourceEntry } from "./research-run.ts";
export { ResearchRun, validateFindings } from "./research-run.ts";
export type { ResearchToolsDeps } from "./retrieval-tools.ts";
export { buildResearchTools, MAX_TOOL_RESULT_CHARS } from "./retrieval-tools.ts";
export type { RecordSessionTranscriptSourceOptions } from "./transcript-source.ts";
export { recordSessionTranscriptSource } from "./transcript-source.ts";
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
export { UnavailableSearchProvider } from "./unavailable-search-provider.ts";
export type {
  ResearchSessionTuning,
  WebResearchToolAgentDeps,
} from "./web-research-tool-agent.ts";
export { DEFAULT_RESEARCH_AGENT_ID, WebResearchToolAgent } from "./web-research-tool-agent.ts";
