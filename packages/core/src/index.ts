/**
 * @shadow/core — domain model and storage.
 *
 * The foundation every other package builds on. Pure: no LLM, no network,
 * no agent code. Everything that reads or writes a volume does so through
 * `VolumeStore` — the filesystem layout under it is this package's private
 * implementation detail (see `ARCHITECTURE.md`).
 */

export {
  ChapterNotFoundError,
  ChapterParseError,
  InvalidSlugError,
  ShadowCoreError,
  VolumeAlreadyExistsError,
  VolumeNotFoundError,
} from "./errors.ts";
export { FileSystemVolumeStore } from "./filesystem-volume-store.ts";
export type { ChapterSlug, VolumeSlug } from "./slug.ts";
export {
  isValidChapterSlug,
  isValidVolumeSlug,
  MAX_SLUG_LENGTH,
  slugify,
  toChapterSlug,
  toVolumeSlug,
} from "./slug.ts";
export type { Chapter, ChapterInput, Volume, VolumeInput, VolumeUpdate } from "./types.ts";
export type { VolumePathResolver, VolumeStore } from "./volume-store.ts";
