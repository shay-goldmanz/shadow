/**
 * Typed error hierarchy for @shadow/evidence, matching the pattern
 * established by `@shadow/core` and `@shadow/indexing`: `instanceof`
 * checks against structured fields, never string-matching `error.message`.
 */

/** Base class for every error this package throws. */
export abstract class ShadowEvidenceError extends Error {
  abstract override readonly name: string;
}

/** A candidate id string was not a well-formed, correctly-prefixed ULID. */
export class InvalidIdError extends ShadowEvidenceError {
  override readonly name = "InvalidIdError";

  constructor(
    public readonly kind: "source" | "claim",
    public readonly input: string,
  ) {
    super(
      `Invalid ${kind} id ${JSON.stringify(input)}: expected a "${kind === "source" ? "src_" : "clm_"}"-prefixed ULID`,
    );
  }
}

/** A candidate digest string was not of the form `sha256:<64 hex chars>`. */
export class InvalidDigestError extends ShadowEvidenceError {
  override readonly name = "InvalidDigestError";

  constructor(public readonly input: string) {
    super(`Invalid digest ${JSON.stringify(input)}: expected "sha256:<64 hex chars>"`);
  }
}

/** `getSource` targeted an id with no source record on disk. */
export class SourceNotFoundError extends ShadowEvidenceError {
  override readonly name = "SourceNotFoundError";

  constructor(public readonly id: string) {
    super(`Source not found: ${id}`);
  }
}

/** `getSnapshotText` targeted a digest with no snapshot on disk. */
export class SnapshotNotFoundError extends ShadowEvidenceError {
  override readonly name = "SnapshotNotFoundError";

  constructor(public readonly normalizedTextSha256: string) {
    super(`Snapshot not found: ${normalizedTextSha256}`);
  }
}

/** `getClaims` targeted a chapter with no claim sidecar on disk. */
export class ClaimSidecarNotFoundError extends ShadowEvidenceError {
  override readonly name = "ClaimSidecarNotFoundError";

  constructor(public readonly chapter: string) {
    super(`Claim sidecar not found for chapter: ${chapter}`);
  }
}

/**
 * A ledger append or read hit a malformed line — e.g. a hand-edited
 * `ledger.ndjson` with invalid JSON on some line. The ledger is append-only
 * and git-diffable specifically so it stays human-editable; this error
 * exists so a corrupt line fails loudly instead of silently truncating
 * history.
 */
export class LedgerCorruptError extends ShadowEvidenceError {
  override readonly name = "LedgerCorruptError";

  constructor(
    public readonly lineNumber: number,
    public readonly reason: string,
  ) {
    super(`Ledger corrupt at line ${lineNumber}: ${reason}`);
  }
}

/**
 * A span-binding request cited a `sourceId` that does not resolve in this
 * volume's evidence ledger — a caller cannot bind evidence to a source it
 * (or the operator) never actually produced. Originally `@shadow/agent`'s
 * error (evidence-binding, D19), moved here alongside `buildSpanFromQuote`
 * (`span-binding.ts`) when the span builder was lifted out of `agent` so
 * every caller of the builder — not just Shadow's own turn loop — gets the
 * same typed error. `@shadow/agent` re-exports this from its own errors
 * module so existing callers there are unaffected.
 */
export class UnknownSourceError extends ShadowEvidenceError {
  override readonly name = "UnknownSourceError";

  constructor(
    public readonly label: string,
    public readonly sourceId: string,
    cause?: unknown,
  ) {
    super(`Claim "${label}" cites source ${JSON.stringify(sourceId)}, which does not exist`, {
      cause,
    });
  }
}

/**
 * A span-binding request's `quote` is not an exact substring of the cited
 * source's current snapshot text. Bind-before-write (D19, the
 * writing-volumes skill's §4): a caller must copy verbatim from what was
 * actually retrieved, transcribed, or read, never paraphrase and hope. See
 * `UnknownSourceError`'s doc for why this now lives here rather than in
 * `@shadow/agent`.
 */
export class UnresolvedEvidenceQuoteError extends ShadowEvidenceError {
  override readonly name = "UnresolvedEvidenceQuoteError";

  constructor(
    public readonly label: string,
    public readonly sourceId: string,
    public readonly quote: string,
  ) {
    super(
      `Claim "${label}"'s quote does not appear verbatim in source ${JSON.stringify(
        sourceId,
      )}'s snapshot: ${JSON.stringify(quote)}`,
    );
  }
}
