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
