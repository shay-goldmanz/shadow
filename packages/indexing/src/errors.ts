/**
 * Typed error hierarchy for @shadow/indexing, matching the pattern
 * established by `@shadow/core` (`instanceof` checks, structured fields,
 * never string-matching `error.message`).
 */

/** Base class for every error this package throws. */
export abstract class ShadowIndexingError extends Error {
  abstract override readonly name: string;
}

/**
 * A chapter's frontmatter carried a value in a field this package
 * interprets (e.g. `confidence`) that could not be coerced into the
 * expected shape. Non-fatal by design elsewhere (unrecognized values are
 * dropped, not thrown) — this exists for callers that want to fail loudly
 * instead, e.g. a future `shadow lint` strict mode.
 */
export class InvalidRoutingFieldError extends ShadowIndexingError {
  override readonly name = "InvalidRoutingFieldError";

  constructor(
    public readonly volumeSlug: string,
    public readonly chapterSlug: string,
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`Invalid "${field}" in frontmatter for ${volumeSlug}/${chapterSlug}: ${reason}`);
  }
}

/**
 * Building the index for one chapter failed unexpectedly (i.e. not one of
 * the typed `@shadow/core` errors, which are left to propagate as-is).
 * Wraps the cause with enough context to locate the offending file.
 */
export class ChapterIndexBuildError extends ShadowIndexingError {
  override readonly name = "ChapterIndexBuildError";

  constructor(
    public readonly volumeSlug: string,
    public readonly chapterSlug: string,
    sourceError: unknown,
  ) {
    const reason = sourceError instanceof Error ? sourceError.message : String(sourceError);
    super(`Failed to build index node for ${volumeSlug}/${chapterSlug}: ${reason}`, {
      cause: sourceError,
    });
  }
}
