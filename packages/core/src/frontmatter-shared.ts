/**
 * Shared parsing primitives for the Markdown + YAML frontmatter document
 * format used by both chapters (`frontmatter.ts`) and volumes
 * (`volume-frontmatter.ts`). Not part of the public API — internal to this
 * package.
 */

// Matches a leading `---\n...\n---` block; the rest of the file is the body.
// Deliberately non-greedy so the *first* closing `---` line terminates the
// frontmatter, even if the body itself later contains a `---` (e.g. a
// Markdown horizontal rule).
export const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

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
