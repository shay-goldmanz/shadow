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
