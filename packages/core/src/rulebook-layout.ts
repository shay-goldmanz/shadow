/**
 * Owns the on-disk layout of a rule book — a deliberately separate bundle
 * kind from a volume, not a specialization of it:
 *
 * ```
 * <root>/
 *   rulebooks/<rulebook-slug>/
 *     RULEBOOK.md              frontmatter + description
 *     groups/<group-slug>.md   chapter-shaped documents
 *     evidence/                standard EvidenceLayout dir
 *     cache/extraction/<key>.json   opaque JSON cache, keyed by caller
 * ```
 *
 * Mirrors `VolumeLayout`'s grain exactly: this is the *only* place that
 * joins a slug (or cache key) onto a path for a rule book.
 * `FileSystemRulebookStore` is the only consumer. Every method re-validates
 * its slug arguments via `toVolumeSlug`/`toChapterSlug` even though the
 * parameter types are already branded, for the same reason `layout.ts`
 * does: the brand can be defeated by an unsafe cast anywhere upstream, and
 * this is the security boundary where that must not matter.
 *
 * Rule book slugs reuse the `VolumeSlug` brand and group slugs reuse the
 * `ChapterSlug` brand (deliberate: no new slug kind) — a rule book is
 * "a volume-shaped container of chapter-shaped groups" purely at the level
 * of slug validation, even though `RulebookLayout` is a distinct class from
 * `VolumeLayout` with its own root (`rulebooks/`, not `volumes/`).
 */

import { join, relative } from "node:path";
import { InvalidSlugError } from "./errors.ts";
import { type ChapterSlug, toChapterSlug, toVolumeSlug, type VolumeSlug } from "./slug.ts";

// Same character class as a slug (see `slug.ts`) — a cache key is caller-supplied
// (e.g. an extraction pipeline stage name or a content hash) and must not be able
// to escape `cache/extraction/` via `..`, a path separator, or a null byte.
const CACHE_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class RulebookLayout {
  constructor(private readonly root: string) {}

  rulebooksDir(): string {
    return join(this.root, "rulebooks");
  }

  rulebookDir(slug: VolumeSlug): string {
    return join(this.rulebooksDir(), toVolumeSlug(slug));
  }

  /** Canonical on-disk rule book document: Markdown + YAML frontmatter, matching a group's (chapter's) shape. */
  rulebookDocPath(slug: VolumeSlug): string {
    return join(this.rulebookDir(slug), "RULEBOOK.md");
  }

  groupsDir(slug: VolumeSlug): string {
    return join(this.rulebookDir(slug), "groups");
  }

  groupPath(rulebook: VolumeSlug, group: ChapterSlug): string {
    return join(this.groupsDir(rulebook), `${toChapterSlug(group)}.md`);
  }

  /**
   * Repo-relative counterpart of `groupPath`, e.g.
   * `rulebooks/<rulebook-slug>/groups/<group-slug>.md` — derived from
   * `groupPath` itself so it can never drift from the real layout, mirroring
   * `VolumeLayout.chapterRelativePath`.
   */
  chapterRelativePath(rulebook: VolumeSlug, group: ChapterSlug): string {
    return relative(this.root, this.groupPath(rulebook, group));
  }

  evidenceDir(slug: VolumeSlug): string {
    return join(this.rulebookDir(slug), "evidence");
  }

  cacheDir(slug: VolumeSlug): string {
    return join(this.rulebookDir(slug), "cache", "extraction");
  }

  /**
   * Path to an opaque extraction-cache JSON file, keyed by whatever the
   * caller (the future `@shadow/rulebook` pipeline) chooses — e.g. a stage
   * name or a content hash. `key` is validated against `CACHE_KEY_PATTERN`
   * before it is ever joined onto a path, so it can't escape `cacheDir`.
   *
   * @throws {InvalidSlugError} if `key` is not `[a-z0-9]+(-[a-z0-9]+)*`.
   */
  cacheFilePath(slug: VolumeSlug, key: string): string {
    if (!CACHE_KEY_PATTERN.test(key)) {
      throw new InvalidSlugError(
        "cache-key",
        key,
        "must be lowercase alphanumeric segments joined by single hyphens " +
          "(no path separators, no dots, no leading/trailing/repeated hyphens, no whitespace)",
      );
    }
    return join(this.cacheDir(slug), `${key}.json`);
  }
}
