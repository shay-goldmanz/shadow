/**
 * Shared parsing primitives for the Markdown + YAML frontmatter document
 * format used by both chapters (`frontmatter.ts`) and volumes
 * (`volume-frontmatter.ts`). Not part of the public API — internal to this
 * package.
 */

import { ReservedFrontmatterKeyError } from "./errors.ts";

// Matches a leading `---\n...\n---` block; the rest of the file is the body.
// Deliberately non-greedy so the *first* closing `---` line terminates the
// frontmatter, even if the body itself later contains a `---` (e.g. a
// Markdown horizontal rule). The content between the fences is optional —
// `---\n---\n` (an empty frontmatter block, only possible in a hand-edited
// file per D4; this package always writes at least `title`) is syntactically
// valid frontmatter delimiting, just with nothing in it, and must still
// reach YAML parsing / field validation rather than being rejected here as
// if the delimiters themselves were missing.
export const FRONTMATTER_PATTERN = /^---\r?\n((?:[\s\S]*?\r?\n)?)---\r?\n?([\s\S]*)$/;

/** Frontmatter keys both document kinds reserve as typed fields; everything else is an open record. */
export const RESERVED_DOCUMENT_KEYS = ["title", "createdAt", "updatedAt"] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasReservedStringFields(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { title: string; createdAt: string; updatedAt: string } {
  return (
    typeof value.title === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

/**
 * Reject an open `frontmatter` record that sets a reserved document key
 * before it ever reaches serialization. `serializeChapterDocument` /
 * `serializeVolumeDocument` write the typed fields first and spread the
 * open record second, so a reserved key in the open record would otherwise
 * silently win — smuggling a fake `title` into the persisted document past
 * the caller's real `title`, or writing a non-string `createdAt`/`updatedAt`
 * that this package can no longer parse back on the next read. Called from
 * every `VolumeStore` write path that accepts caller-supplied frontmatter
 * (`putChapter`, `createVolume`, `updateVolume`) so the guard is uniform
 * across both document kinds and can never be bypassed by a new call site.
 *
 * @throws {ReservedFrontmatterKeyError} if `frontmatter` sets any of
 *   `RESERVED_DOCUMENT_KEYS`.
 */
export function assertNoReservedFrontmatterKeys(
  frontmatter: Readonly<Record<string, unknown>>,
  kind: "chapter" | "volume",
  slug: string,
): void {
  const offending = RESERVED_DOCUMENT_KEYS.filter((key) => key in frontmatter);
  if (offending.length > 0) {
    throw new ReservedFrontmatterKeyError(kind, slug, offending);
  }
}
