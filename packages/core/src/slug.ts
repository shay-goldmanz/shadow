/**
 * Branded slug types and validation.
 *
 * This is the security boundary for the whole package: a slug is used to
 * build a filesystem path (see `layout.ts`), so anything that could escape
 * the volume root — `..`, an absolute path, a null byte — must be rejected
 * here, unconditionally, before it ever reaches `node:path`/`node:fs`.
 *
 * `VolumeSlug` and `ChapterSlug` are nominal (branded) types: a bare
 * `string` cannot be passed where a slug is expected. The *only* way to
 * produce one is `toVolumeSlug`/`toChapterSlug`, which validate as they
 * brand. Store implementations re-validate at the path-building boundary
 * too (see `layout.ts`), so even a forged brand (`"../x" as VolumeSlug`,
 * e.g. from an unsafe cast or a value that skipped this module) cannot
 * reach the filesystem.
 */

import { InvalidSlugError } from "./errors.ts";

/** Maximum slug length, in characters. Generous for a title-derived slug, bounded against abuse. */
export const MAX_SLUG_LENGTH = 100;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

declare const volumeSlugBrand: unique symbol;
/** A validated, filesystem-safe volume identifier. Construct via `toVolumeSlug`. */
export type VolumeSlug = string & { readonly [volumeSlugBrand]: true };

declare const chapterSlugBrand: unique symbol;
/** A validated, filesystem-safe chapter identifier. Construct via `toChapterSlug`. */
export type ChapterSlug = string & { readonly [chapterSlugBrand]: true };

type SlugKind = "volume" | "chapter";

function validate(kind: SlugKind, input: string): void {
  if (typeof input !== "string" || input.length === 0) {
    throw new InvalidSlugError(kind, input, "must be a non-empty string");
  }
  if (input.includes("\0")) {
    throw new InvalidSlugError(kind, input, "must not contain a null byte");
  }
  if (input.length > MAX_SLUG_LENGTH) {
    throw new InvalidSlugError(kind, input, `must be at most ${MAX_SLUG_LENGTH} characters`);
  }
  if (!SLUG_PATTERN.test(input)) {
    throw new InvalidSlugError(
      kind,
      input,
      "must be lowercase alphanumeric segments joined by single hyphens " +
        "(no path separators, no dots, no leading/trailing/repeated hyphens, no whitespace)",
    );
  }
}

/**
 * Validate a raw string as a volume slug and brand it.
 * @throws {InvalidSlugError} if `input` fails validation.
 */
export function toVolumeSlug(input: string): VolumeSlug {
  validate("volume", input);
  return input as VolumeSlug;
}

/**
 * Validate a raw string as a chapter slug and brand it.
 * @throws {InvalidSlugError} if `input` fails validation.
 */
export function toChapterSlug(input: string): ChapterSlug {
  validate("chapter", input);
  return input as ChapterSlug;
}

/** Type-guarding predicate form of `toVolumeSlug`, for filtering untrusted input without try/catch. */
export function isValidVolumeSlug(input: string): input is VolumeSlug {
  try {
    validate("volume", input);
    return true;
  } catch {
    return false;
  }
}

/** Type-guarding predicate form of `toChapterSlug`, for filtering untrusted input without try/catch. */
export function isValidChapterSlug(input: string): input is ChapterSlug {
  try {
    validate("chapter", input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort conversion of an arbitrary title-like string into a slug
 * candidate: lowercased, diacritics stripped, non-alphanumeric runs
 * collapsed to single hyphens, trimmed, and bounded to `MAX_SLUG_LENGTH`.
 *
 * The result is usually valid, but callers must still pass it through
 * `toVolumeSlug`/`toChapterSlug` (or check `isValidVolumeSlug`/
 * `isValidChapterSlug`) — degenerate input (e.g. a string with no
 * alphanumeric characters at all) can still slugify to `""`.
 */
export function slugify(input: string): string {
  const combiningDiacriticals = new RegExp("[\\u0300-\\u036f]", "g");
  const normalized = input
    .normalize("NFKD")
    .replace(combiningDiacriticals, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
}
