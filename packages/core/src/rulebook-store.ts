import type { Rulebook, RulebookInput } from "./rulebook-frontmatter.ts";
import type { ChapterSlug, VolumeSlug } from "./slug.ts";
import type { Chapter, ChapterInput } from "./types.ts";
import type { VolumePathResolver } from "./volume-store.ts";

/**
 * The storage port for a rule book — its own bundle kind under
 * `<shadow-root>/rulebooks/<slug>/`, deliberately not a volume. Mirrors
 * `VolumeStore`'s grain: `extends VolumePathResolver`
 * for the same reason `VolumeStore` does — `@shadow/evidence` composes over
 * this port (via `evidenceDir`/`ensureEvidenceDir`) without depending on the
 * rest of this interface, and without knowing whether the resolver behind
 * it is a volume or a rule book.
 *
 * Groups (`putGroup`/`getGroup`/`listGroups`) are chapter-shaped documents —
 * this package reuses `Chapter`/`ChapterInput` and
 * `parseChapterDocument`/`serializeChapterDocument` as-is rather than
 * defining a parallel `Group` type, since a rule book is "a store of
 * grouped rules rather than prose chapters" but the document shape (typed
 * OKF fields + Markdown body) is identical.
 *
 * Rule book slugs and group slugs reuse the existing `VolumeSlug`/
 * `ChapterSlug` brands rather than introducing a new slug kind (deliberate
 * decision) — `chapterRelativePath(rulebookSlug, groupSlug)` below takes
 * the same argument types `VolumeStore.chapterRelativePath` does.
 */
export interface RulebookStore extends VolumePathResolver {
  /** @throws {RulebookAlreadyExistsError} if `input.slug` already has a rule book on disk. */
  createRulebook(input: RulebookInput): Promise<Rulebook>;

  /** @throws {RulebookNotFoundError} if `slug` has no rule book on disk. */
  getRulebook(slug: VolumeSlug): Promise<Rulebook>;

  /** Rule books sorted by slug. Empty array if none exist yet. */
  listRulebooks(): Promise<Rulebook[]>;

  /**
   * Write the rule book document, creating it if it doesn't exist yet or
   * updating it in place if it does — an upsert, like `putGroup`/
   * `putChapter`, not a strict update. On an existing rule book, any
   * optional field omitted from `input` preserves its current on-disk
   * value rather than resetting to a hardcoded default; hardcoded defaults
   * apply only when no rule book exists yet at `input.slug`. `createdAt` is
   * preserved across overwrites; `updatedAt` always advances.
   */
  updateRulebook(input: RulebookInput): Promise<Rulebook>;

  /**
   * Write a group, creating it if it doesn't exist yet or overwriting it
   * in place if it does — an upsert, like `VolumeStore.putChapter`. Unlike
   * that method, an omitted OKF field (`type`, `status`, `staleAfter`,
   * `generated`, `verified`) or omitted `frontmatter` on an *existing*
   * group preserves its current on-disk value rather than resetting to a
   * hardcoded default — the clobber-on-upsert bug `putChapter` has is
   * deliberately not replicated here. `createdAt` is preserved across
   * overwrites; `updatedAt` always advances.
   *
   * @throws {RulebookNotFoundError} if `rulebookSlug` has no rule book on disk.
   */
  putGroup(rulebookSlug: VolumeSlug, input: ChapterInput): Promise<Chapter>;

  /**
   * @throws {RulebookNotFoundError} if `rulebookSlug` has no rule book on disk.
   * @throws {GroupNotFoundError} if `groupSlug` has no group on disk.
   */
  getGroup(rulebookSlug: VolumeSlug, groupSlug: ChapterSlug): Promise<Chapter>;

  /**
   * Groups sorted by slug. Empty array if the rule book has none yet.
   * @throws {RulebookNotFoundError} if `rulebookSlug` has no rule book on disk.
   */
  listGroups(rulebookSlug: VolumeSlug): Promise<Chapter[]>;

  /**
   * Read an opaque extraction-cache JSON value, keyed by `key` (a future
   * extraction pipeline's choice — e.g. a stage name or content hash).
   * `null` if nothing has been cached under `key` yet, which is not an
   * error. This package does not know the cached value's shape; `T` is
   * asserted by the caller.
   *
   * @throws {RulebookNotFoundError} if `rulebookSlug` has no rule book on disk.
   * @throws {InvalidSlugError} if `key` is not a safe cache-key shape.
   */
  readExtractionCache<T = unknown>(rulebookSlug: VolumeSlug, key: string): Promise<T | null>;

  /**
   * Overwrite the extraction-cache JSON value at `key` with an opaque
   * value.
   *
   * @throws {RulebookNotFoundError} if `rulebookSlug` has no rule book on disk.
   * @throws {InvalidSlugError} if `key` is not a safe cache-key shape.
   */
  writeExtractionCache(rulebookSlug: VolumeSlug, key: string, value: unknown): Promise<void>;
}
