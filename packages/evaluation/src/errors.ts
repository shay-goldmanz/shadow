/**
 * Typed error hierarchy for @shadow/evaluation, matching the pattern
 * established by `@shadow/core` and `@shadow/indexing` (`instanceof`
 * checks, structured fields, never string-matching `error.message`).
 */

/** Base class for every error this package throws. */
export abstract class ShadowEvaluationError extends Error {
  abstract override readonly name: string;
}

/**
 * A golden query set entry failed structural validation — e.g. it names a
 * `(volumeSlug, chapterSlug)` pair that does not exist in the fixed corpus,
 * or a query id is duplicated. Thrown by `loadGoldenSet`/`validateGoldenSet`
 * before any strategy runs, so a broken golden set fails loudly rather than
 * silently scoring against chapters that no longer exist.
 */
export class GoldenSetValidationError extends ShadowEvaluationError {
  override readonly name = "GoldenSetValidationError";

  constructor(public readonly problems: readonly string[]) {
    super(`Golden set failed validation:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}

/**
 * The fixed fixture corpus under `fixtures/corpus` could not be loaded —
 * missing directory, no volumes found, or an I/O failure copying it into a
 * scratch `VolumeStore` root.
 */
export class CorpusLoadError extends ShadowEvaluationError {
  override readonly name = "CorpusLoadError";

  constructor(
    public readonly path: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`Failed to load fixture corpus from "${path}": ${reason}`, options);
  }
}

/**
 * A strategy was asked to run in `--live` mode but no live
 * `StructuredGenerationPort` was supplied — e.g. `run-eval.ts` was invoked
 * with `--live` but the harness was constructed without a real model.
 */
export class LiveModeConfigError extends ShadowEvaluationError {
  override readonly name = "LiveModeConfigError";
}
