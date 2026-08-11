/**
 * Typed error hierarchy for @shadow/core.
 *
 * Every failure mode a caller needs to branch on has its own class with
 * structured fields (never just a string). `instanceof` checks against
 * these — not string-matching `error.message` — is the supported way to
 * handle them.
 */

/** Base class for every error this package throws. */
export abstract class ShadowCoreError extends Error {
  abstract override readonly name: string;
}

/** A volume or chapter slug failed validation (see `slug.ts`). */
export class InvalidSlugError extends ShadowCoreError {
  override readonly name = "InvalidSlugError";

  constructor(
    public readonly kind: "volume" | "chapter",
    public readonly input: string,
    public readonly reason: string,
  ) {
    super(`Invalid ${kind} slug ${JSON.stringify(input)}: ${reason}`);
  }
}

/** `getVolume`, `updateVolume`, or `deleteVolume` targeted a slug with no volume on disk. */
export class VolumeNotFoundError extends ShadowCoreError {
  override readonly name = "VolumeNotFoundError";

  constructor(public readonly slug: string) {
    super(`Volume not found: ${slug}`);
  }
}

/** `createVolume` targeted a slug that already has a volume on disk. */
export class VolumeAlreadyExistsError extends ShadowCoreError {
  override readonly name = "VolumeAlreadyExistsError";

  constructor(public readonly slug: string) {
    super(`Volume already exists: ${slug}`);
  }
}

/** `getChapter` or `deleteChapter` targeted a slug with no chapter on disk. */
export class ChapterNotFoundError extends ShadowCoreError {
  override readonly name = "ChapterNotFoundError";

  constructor(
    public readonly volumeSlug: string,
    public readonly chapterSlug: string,
  ) {
    super(`Chapter not found: ${volumeSlug}/${chapterSlug}`);
  }
}

/**
 * An on-disk chapter file could not be parsed as frontmatter + Markdown.
 * Chapters are hand-editable by the operator (D4), so a malformed file is an
 * expected failure mode, not a crash.
 */
export class ChapterParseError extends ShadowCoreError {
  override readonly name = "ChapterParseError";

  constructor(
    public readonly chapterSlug: string,
    public readonly reason: string,
  ) {
    super(`Failed to parse chapter "${chapterSlug}": ${reason}`);
  }
}
