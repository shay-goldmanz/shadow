/**
 * Coercion helpers for chapter/volume frontmatter routing fields.
 *
 * Frontmatter is opaque `Record<string, unknown>` as far as `@shadow/core`
 * is concerned (see `Chapter.frontmatter`'s doc comment there), so this
 * package must defensively coerce rather than assume shapes — a hand-
 * edited chapter (D4: volumes are hand-editable) can carry anything.
 *
 * One genuine spec inconsistency drives the `string | string[]` handling
 * below: `docs/INDEXING.md`'s own frontmatter example writes `when_to_use`
 * as a single folded YAML scalar (a string), but `@shadow/core`'s own test
 * fixtures (`volume-store.contract.ts`, `index.test.ts`) consistently
 * author `when_to_use`/`not_for` as string arrays. Both are accepted here
 * and normalized to the single string `index.json` specifies. Flagged in
 * the implementation report.
 */

import type { Confidence } from "./types.ts";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Coerce a routing text field (`when_to_use`, `not_for`) authored as either a string or a string array. */
export function coerceRoutingText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (isStringArray(value) && value.length > 0) {
    return value.join("; ");
  }
  return undefined;
}

/** Coerce `keywords` / `supersedes` / `aliases`: documented as string arrays. */
export function coerceStringArray(value: unknown): string[] | undefined {
  return isStringArray(value) && value.length > 0 ? value : undefined;
}

/** Coerce `confidence`: must be exactly one of the documented enum values, else dropped. */
export function coerceConfidence(value: unknown): Confidence | undefined {
  if (value === "high" || value === "medium" || value === "provisional") {
    return value;
  }
  return undefined;
}

/** Coerce `updated`: passed through verbatim if a non-empty string (no date parsing/validation). */
export function coerceDateLike(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
