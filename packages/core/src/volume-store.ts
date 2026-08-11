import type { ChapterSlug, VolumeSlug } from "./slug.ts";
import type { Chapter, ChapterInput, Volume, VolumeInput, VolumeUpdate } from "./types.ts";

/**
 * Narrow port for resolving where a volume's evidence ledger lives, without
 * exposing the storage root or any path-building capability beyond that one
 * directory.
 *
 * This is the answer to "no other package builds a path" for `@shadow/evidence`
 * specifically: rather than depend on the full `VolumeStore` (and everything
 * that implies about chapter/volume CRUD), evidence depends only on this.
 * Interface segregation, not just convention, keeps evidence from ever being
 * tempted to construct a sibling path (`../chapters/...`) itself.
 */
export interface VolumePathResolver {
  /**
   * The evidence directory for `volume`. Pure path arithmetic — does not
   * touch the filesystem, so it never fails and never implies the
   * directory (or even the volume) exists.
   */
  evidenceDir(volume: VolumeSlug): string;

  /**
   * Like `evidenceDir`, but also creates the directory (and its parents) if
   * missing, and confirms the volume itself exists first.
   *
   * @throws {VolumeNotFoundError} if `volume` has no volume on disk.
   */
  ensureEvidenceDir(volume: VolumeSlug): Promise<string>;

  /**
   * Repo-relative path to a chapter's Markdown file, e.g.
   * `volumes/<volume-slug>/chapters/<chapter-slug>.md` — the on-disk
   * layout convention consumers need to populate an index's informational
   * `file` field (`docs/INDEXING.md`) without hardcoding or re-deriving it
   * themselves. Pure path arithmetic, like `evidenceDir`: no I/O, never
   * fails on a nonexistent volume/chapter, and re-validates both slugs at
   * the join site the same way every other path-building method in this
   * package does.
   *
   * @throws {InvalidSlugError} if either slug is a forged brand that fails re-validation.
   */
  chapterRelativePath(volume: VolumeSlug, chapter: ChapterSlug): string;
}

/**
 * The storage port every other package depends on instead of the
 * filesystem. See `FileSystemVolumeStore` for the (currently only)
 * implementation.
 *
 * All read/write of a volume or chapter goes through here — including the
 * index document, which this package stores but does not interpret
 * (`readIndex`/`writeIndex` are opaque JSON, typed by the caller;
 * `@shadow/indexing` owns the schema).
 */
export interface VolumeStore extends VolumePathResolver {
  /** @throws {VolumeAlreadyExistsError} if `input.slug` already has a volume on disk. */
  createVolume(input: VolumeInput): Promise<Volume>;

  /** @throws {VolumeNotFoundError} if `slug` has no volume on disk. */
  getVolume(slug: VolumeSlug): Promise<Volume>;

  /** Volumes sorted by slug. Empty array if none exist yet. */
  listVolumes(): Promise<Volume[]>;

  /** @throws {VolumeNotFoundError} if `slug` has no volume on disk. */
  updateVolume(slug: VolumeSlug, patch: VolumeUpdate): Promise<Volume>;

  /** @throws {VolumeNotFoundError} if `slug` has no volume on disk. */
  deleteVolume(slug: VolumeSlug): Promise<void>;

  /**
   * Write a chapter, creating it if it doesn't exist yet or overwriting it
   * in place if it does. Unlike `createVolume`, this is an upsert — it does
   * not fail on an existing chapter. `createdAt` is preserved across
   * overwrites; `updatedAt` always advances.
   *
   * @throws {VolumeNotFoundError} if `volume` has no volume on disk.
   */
  putChapter(volume: VolumeSlug, input: ChapterInput): Promise<Chapter>;

  /**
   * @throws {VolumeNotFoundError} if `volume` has no volume on disk.
   * @throws {ChapterNotFoundError} if `chapter` has no chapter on disk.
   */
  getChapter(volume: VolumeSlug, chapter: ChapterSlug): Promise<Chapter>;

  /**
   * Chapters sorted by slug. Empty array if the volume has none yet.
   * @throws {VolumeNotFoundError} if `volume` has no volume on disk.
   */
  listChapters(volume: VolumeSlug): Promise<Chapter[]>;

  /**
   * @throws {VolumeNotFoundError} if `volume` has no volume on disk.
   * @throws {ChapterNotFoundError} if `chapter` has no chapter on disk.
   */
  deleteChapter(volume: VolumeSlug, chapter: ChapterSlug): Promise<void>;

  /**
   * Read the index document for `volume`. This package does not know its
   * shape — `T` is asserted by the caller (`@shadow/indexing` owns the
   * schema). Returns `undefined` if no index has been written yet, which is
   * not an error: a freshly created volume has no index.
   *
   * @throws {VolumeNotFoundError} if `volume` has no volume on disk.
   */
  readIndex<T = unknown>(volume: VolumeSlug): Promise<T | undefined>;

  /**
   * Overwrite the index document for `volume` with an opaque JSON value.
   * @throws {VolumeNotFoundError} if `volume` has no volume on disk.
   */
  writeIndex(volume: VolumeSlug, index: unknown): Promise<void>;

  /**
   * Read the corpus-wide index document, spanning every volume this store
   * knows about — the root-level counterpart of `readIndex`
   * (`docs/INDEXING.md`'s single corpus `index.json`). This package does
   * not know its shape; `T` is asserted by the caller (`@shadow/indexing`
   * owns the schema). Returns `undefined` if none has been written yet,
   * which is not an error. Independent of any per-volume `index.json`:
   * neither read nor write here touches those.
   */
  readCorpusIndex<T = unknown>(): Promise<T | undefined>;

  /**
   * Overwrite the corpus-wide index document with an opaque JSON value.
   * Independent of `writeIndex` — this package makes no attempt to keep a
   * per-volume index and the corpus index in sync; that is the caller's
   * job.
   */
  writeCorpusIndex(index: unknown): Promise<void>;
}
