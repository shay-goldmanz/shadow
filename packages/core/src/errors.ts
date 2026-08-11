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

/**
 * An on-disk `VOLUME.md` document could not be parsed as frontmatter +
 * Markdown. Volumes are hand-editable by the operator (D4), so a malformed
 * file is an expected failure mode, not a crash.
 */
export class VolumeParseError extends ShadowCoreError {
  override readonly name = "VolumeParseError";

  constructor(
    public readonly volumeSlug: string,
    public readonly reason: string,
  ) {
    super(`Failed to parse volume "${volumeSlug}": ${reason}`);
  }
}

/**
 * `putChapter`/`createVolume`/`updateVolume` was given an open `frontmatter`
 * record that sets one of the reserved document keys (`title`, `createdAt`,
 * `updatedAt`). Those are typed fields this package owns, not part of the
 * open record — letting one through would let a caller silently overwrite
 * the document's real title/timestamps on write (`serializeChapterDocument`/
 * `serializeVolumeDocument` write typed fields first, open record second),
 * or write a value (e.g. a non-string `createdAt`) that this package can no
 * longer parse back on the very next read. Rejected rather than silently
 * stripped: silently discarding operator/agent-authored frontmatter is its
 * own failure mode, and a caller that meant to set the real title should
 * see that immediately rather than have it vanish.
 */
export class ReservedFrontmatterKeyError extends ShadowCoreError {
  override readonly name = "ReservedFrontmatterKeyError";

  constructor(
    public readonly kind: "chapter" | "volume",
    public readonly slug: string,
    public readonly keys: readonly string[],
  ) {
    super(
      `Cannot write ${kind} "${slug}": frontmatter must not set reserved key(s) ` +
        `${keys.map((key) => JSON.stringify(key)).join(", ")} — title/createdAt/updatedAt are ` +
        `typed fields owned by @shadow/core, not part of the open frontmatter record.`,
    );
  }
}
