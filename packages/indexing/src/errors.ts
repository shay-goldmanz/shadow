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

/**
 * `shadow read <node_id>` (STAGE 4) was asked for a `node_id` that does
 * not resolve to any chapter or section in the given `IndexDocument` —
 * a stale citation, a typo, or a node from a different corpus build.
 */
export class NodeNotFoundError extends ShadowIndexingError {
  override readonly name = "NodeNotFoundError";

  constructor(public readonly nodeId: string) {
    super(`No node with node_id "${nodeId}" was found in the index`);
  }
}

/**
 * `runLint` (`lint.ts`, T2.6) was called without `options.offline` but
 * without the `deps.store`/`deps.port` the model-backed checks (2
 * self-retrieval, 4 contradiction) need to run. Thrown before either check
 * makes any I/O or model call — never a silent skip, since a caller who
 * expected the full check set to run deserves to know it didn't.
 */
export class LintConfigError extends ShadowIndexingError {
  override readonly name = "LintConfigError";
}
