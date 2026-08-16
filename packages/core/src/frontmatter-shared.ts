/**
 * Shared parsing primitives for the Markdown + YAML frontmatter document
 * format used by both chapters (`frontmatter.ts`) and volumes
 * (`volume-frontmatter.ts`). Not part of the public API — internal to this
 * package.
 */

import { ReservedFrontmatterKeyError } from "./errors.ts";
import type { OkfActor, OkfStatus } from "./types.ts";

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
export const RESERVED_DOCUMENT_KEYS = [
  "title",
  "createdAt",
  "updatedAt",
  "type",
  "status",
  "stale_after",
  "generated",
  "verified",
] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check that the required typed string fields in a parsed YAML frontmatter mapping are present and well-typed. */
export function hasRequiredTypedFields(value: Record<string, unknown>): value is Record<
  string,
  unknown
> & {
  title: string;
  createdAt: string;
  updatedAt: string;
  type: string;
} {
  return (
    typeof value.title === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.type === "string" &&
    value.type.length > 0
  );
}

// ---- OKF v0.2 field parsers (shared between chapter and volume documents) -------

/** Format a Date as YYYY-MM-DD for the `stale_after` field. */
export function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Parse a `stale_after` YYYY-MM-DD value into a Date, or return null. */
export function parseStaleAfter(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/** Parse an OKF `status` value, defaulting to "draft". */
export function parseOkfStatus(raw: unknown): OkfStatus {
  if (raw === "stable" || raw === "deprecated") return raw;
  return "draft";
}

/** Parse a parsed-YAML `generated` field into an OkfActor, or return null. */
export function parseOkfActor(raw: unknown): OkfActor | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.by !== "string" || typeof raw.at !== "string") return null;
  const at = new Date(raw.at);
  if (isNaN(at.getTime())) return null;
  return { by: raw.by, at };
}

/** Parse a parsed-YAML `verified` field. Accepts a single mapping or an array (OKF §5.2). */
export function parseVerified(raw: unknown): OkfActor[] {
  if (isRecord(raw) && typeof raw.by === "string" && typeof raw.at === "string") {
    const at = new Date(raw.at);
    if (!isNaN(at.getTime())) return [{ by: raw.by, at }];
  }
  if (Array.isArray(raw)) {
    const out: OkfActor[] = [];
    for (const item of raw) {
      const actor = parseOkfActor(item);
      if (actor) out.push(actor);
    }
    return out;
  }
  return [];
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
