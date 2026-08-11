/**
 * Typed error hierarchy for @shadow/research.
 *
 * Every failure mode a caller needs to branch on has its own class with
 * structured fields (never just a string). `instanceof` checks against
 * these — not string-matching `error.message` — is the supported way to
 * handle them. Mirrors the convention established in `@shadow/core`.
 */

/** Base class for every error this package throws. */
export abstract class ShadowResearchError extends Error {
  abstract override readonly name: string;
}

/**
 * The underlying `fetch` call failed outright — DNS, TLS, connection
 * refused, or any other transport-level failure that is not a timeout.
 */
export class RetrievalNetworkError extends ShadowResearchError {
  override readonly name = "RetrievalNetworkError";

  constructor(
    public readonly url: string,
    public readonly reason: string,
    cause?: unknown,
  ) {
    super(`Failed to fetch ${JSON.stringify(url)}: ${reason}`, { cause });
  }
}

/** A live fetch did not complete within the configured timeout. */
export class RetrievalTimeoutError extends ShadowResearchError {
  override readonly name = "RetrievalTimeoutError";

  constructor(
    public readonly url: string,
    public readonly timeoutMs: number,
  ) {
    super(`Fetching ${JSON.stringify(url)} did not complete within ${timeoutMs}ms`);
  }
}

/**
 * The response body exceeded the configured size cap, either up front via
 * `Content-Length` or discovered mid-stream. `actualBytes` is the size that
 * tripped the cap when known (may be a lower bound if streaming was
 * aborted early).
 */
export class PayloadTooLargeError extends ShadowResearchError {
  override readonly name = "PayloadTooLargeError";

  constructor(
    public readonly url: string,
    public readonly limitBytes: number,
    public readonly actualBytes?: number,
  ) {
    super(
      `Response for ${JSON.stringify(url)} exceeds the ${limitBytes}-byte cap` +
        (actualBytes === undefined ? "" : ` (${actualBytes} bytes and counting)`),
    );
  }
}

/**
 * The response's `Content-Type` was missing or not in the configured
 * allowlist. Research only ever wants renderable text; refusing everything
 * else up front is cheaper and more honest than trying to extract text from
 * a PDF or an image and hashing garbage.
 */
export class UnsupportedContentTypeError extends ShadowResearchError {
  override readonly name = "UnsupportedContentTypeError";

  constructor(
    public readonly url: string,
    public readonly contentType: string | null,
  ) {
    super(`Unsupported content type for ${JSON.stringify(url)}: ${JSON.stringify(contentType)}`);
  }
}

/**
 * A non-2xx HTTP status was returned and `LiveTransportOptions.allowNon2xx`
 * was not set. Refused by default (Wave 1 review, Fix 4): a 404, a 500
 * error page, or a redirect chain's final error response must never
 * silently become a fixture and, downstream, an evidence source record —
 * "the page still resolves" is exactly the false confidence D16 warns
 * about, and a non-2xx status is a much cheaper signal to catch than
 * content drift. Callers that genuinely want the error body (e.g. to
 * detect and report link rot) opt in explicitly.
 */
export class UnsuccessfulHttpStatusError extends ShadowResearchError {
  override readonly name = "UnsuccessfulHttpStatusError";

  constructor(
    public readonly url: string,
    public readonly httpStatus: number,
  ) {
    super(
      `Refusing ${JSON.stringify(url)}: HTTP ${httpStatus} is not a 2xx success status. ` +
        `Set LiveTransportOptions.allowNon2xx to opt into recording non-2xx responses.`,
    );
  }
}

/**
 * Replay mode found no recorded fixture for this request. **Fails loudly
 * by design** (D2) — replay must never fall through to a live fetch on a
 * miss, because that would silently reintroduce network non-determinism
 * into a test suite that assumes an offline, frozen corpus.
 */
export class FixtureMissError extends ShadowResearchError {
  override readonly name = "FixtureMissError";

  constructor(
    public readonly kind: "page" | "search",
    public readonly key: string,
    public readonly corpusRoot: string,
  ) {
    super(
      `No fixture recorded for ${kind} ${JSON.stringify(key)} under ${JSON.stringify(corpusRoot)}. ` +
        `Replay never falls through to a live fetch — record this fixture first (mode: "record").`,
    );
  }
}

/**
 * A fixture on disk was structurally invalid: unparsable JSON, a page
 * fixture whose referenced payload file is missing, or a schema-version
 * mismatch. Distinct from `FixtureMissError` (nothing recorded) — this
 * means something *is* recorded but is corrupt or unreadable.
 */
export class FixtureCorpusError extends ShadowResearchError {
  override readonly name = "FixtureCorpusError";

  constructor(
    public readonly path: string,
    reason: string,
  ) {
    super(`Corrupt fixture at ${JSON.stringify(path)}: ${reason}`);
  }
}

/**
 * `search()` was called against the live transport with no search provider
 * configured. We have no credentials for a live web search API, so live
 * search is genuinely unimplemented rather than a `TODO` — see
 * `docs/PLAN.md` T2.1a's report. The replay path is fully implemented and
 * is what tests use; this error only fires if live mode is asked to search.
 */
export class LiveSearchUnavailableError extends ShadowResearchError {
  override readonly name = "LiveSearchUnavailableError";

  constructor(public readonly query: string) {
    super(
      `Live web search is not implemented (query: ${JSON.stringify(query)}). ` +
        `The search port and its replay/record implementations are complete; only a live ` +
        `backend is missing. Plug one in via LiveTransportOptions.search.`,
    );
  }
}

// ---------------------------------------------------------------------------
// T2.1b — research briefs and tool-agents
// ---------------------------------------------------------------------------

/**
 * A tool-agent tried to submit a finding whose citation does not resolve
 * against anything actually fetched in this research run — either the
 * `sourceId` was never produced by the `fetch` tool, the `quote` is not a
 * substring of that source's extracted text, or the finding carried zero
 * citations at all. This is the structural refusal `docs/ARCHITECTURE.md`
 * promises: a tool-agent cannot cite what it never fetched, full stop, not
 * "cite what it never fetched and get a warning." See `research-run.ts`'s
 * `validateFindings`.
 */
export class UnboundCitationError extends ShadowResearchError {
  override readonly name = "UnboundCitationError";

  constructor(
    public readonly findingText: string,
    public readonly sourceId: string | undefined,
    public readonly reason: string,
  ) {
    super(
      `Refusing to bind finding ${JSON.stringify(findingText)}: ${reason}` +
        (sourceId ? ` (sourceId: ${JSON.stringify(sourceId)})` : ""),
    );
  }
}

/**
 * `ResearchBrief.maxSources` was already reached when the `fetch` tool was
 * called again. Checked *before* the retrieval, so it bounds spend rather
 * than merely bounding what gets kept.
 */
export class SourceBudgetExceededError extends ShadowResearchError {
  override readonly name = "SourceBudgetExceededError";

  constructor(public readonly maxSources: number) {
    super(`This research brief's source budget (${maxSources}) is already exhausted.`);
  }
}

/**
 * The agentic session's turn for this brief reported `isError: true` — a
 * transport/process-level failure inside the model turn itself, distinct
 * from `UnboundCitationError` (a *successful* turn that tried to fabricate
 * a citation).
 */
export class ResearchTurnFailedError extends ShadowResearchError {
  override readonly name = "ResearchTurnFailedError";

  constructor(
    public readonly goal: string,
    public readonly stopReason: string | null,
    public readonly text: string,
  ) {
    super(
      `Research turn for brief ${JSON.stringify(goal)} failed ` +
        `(stopReason: ${JSON.stringify(stopReason)}): ${text || "(no text)"}`,
    );
  }
}

/**
 * The tool-agent's turn completed successfully (no `isError`) but never
 * called `submit_findings` with a validated finding — e.g. it gave up, ran
 * out of turns, or only ever attempted citations `validateFindings`
 * rejected. This is what makes "fails rather than silently producing an
 * unbacked finding" true end-to-end: `research()` never returns an empty
 * or partial `ResearchResult` on this path, it throws.
 */
export class NoFindingsProducedError extends ShadowResearchError {
  override readonly name = "NoFindingsProducedError";

  constructor(
    public readonly goal: string,
    public readonly finalText: string,
  ) {
    super(
      `Research brief ${JSON.stringify(goal)} completed with no findings bound to a real ` +
        `retrieval. Final turn text: ${finalText || "(empty)"}`,
    );
  }
}

/**
 * `WebResearchToolAgent.research()` was called while a previous call on the
 * same instance is still in flight. Sessions are reused (D6), which means
 * one mutable "active run" context backs the shared tool server — see
 * `web-research-tool-agent.ts`. Concurrent calls would corrupt which run a
 * `fetch`/`submit_findings` call is scoped to, so this is refused rather
 * than silently interleaved.
 */
export class ResearchAgentBusyError extends ShadowResearchError {
  override readonly name = "ResearchAgentBusyError";

  constructor(public readonly goal: string) {
    super(
      `This WebResearchToolAgent is already running a brief; cannot start ${JSON.stringify(goal)} ` +
        `concurrently on the same instance. Create a second tool-agent (and session) for parallel briefs.`,
    );
  }
}
