/**
 * Owns the on-disk layout described in `ARCHITECTURE.md`:
 *
 * ```
 * <root>/
 *   index.json                    corpus-wide index, spans every volume
 *   volumes/<volume-slug>/
 *     VOLUME.md                   frontmatter + description (legacy volume.json still read)
 *     chapters/<chapter-slug>.md
 *     index.json                  per-volume index
 *     evidence/
 * ```
 *
 * This is the *only* place in the whole codebase that joins a slug onto a
 * path. `FileSystemVolumeStore` is the only consumer. Every method
 * re-validates its slug arguments via `toVolumeSlug`/`toChapterSlug` even
 * though the parameter types are already branded — the brand can be
 * defeated by an unsafe cast (`"../x" as VolumeSlug`) anywhere upstream,
 * and this is the security boundary where that must not matter.
 */

import { join, relative } from "node:path";
import { type ChapterSlug, toChapterSlug, toVolumeSlug, type VolumeSlug } from "./slug.ts";

export class VolumeLayout {
  constructor(private readonly root: string) {}

  volumesDir(): string {
    return join(this.root, "volumes");
  }

  volumeDir(slug: VolumeSlug): string {
    return join(this.volumesDir(), toVolumeSlug(slug));
  }

  /** Legacy on-disk volume record, superseded by `volumeDocPath` — still read for backward compatibility. */
  volumeMetaPath(slug: VolumeSlug): string {
    return join(this.volumeDir(slug), "volume.json");
  }

  /** Canonical on-disk volume document: Markdown + YAML frontmatter, matching a chapter's shape. */
  volumeDocPath(slug: VolumeSlug): string {
    return join(this.volumeDir(slug), "VOLUME.md");
  }

  chaptersDir(slug: VolumeSlug): string {
    return join(this.volumeDir(slug), "chapters");
  }

  chapterPath(volume: VolumeSlug, chapter: ChapterSlug): string {
    return join(this.chaptersDir(volume), `${toChapterSlug(chapter)}.md`);
  }

  /**
   * Repo-relative counterpart of `chapterPath`, e.g.
   * `volumes/<volume-slug>/chapters/<chapter-slug>.md`. Derived from
   * `chapterPath` itself (rather than re-assembling the segments) so it can
   * never drift from the real layout if it ever changes, and inherits that
   * method's slug re-validation.
   */
  chapterRelativePath(volume: VolumeSlug, chapter: ChapterSlug): string {
    return relative(this.root, this.chapterPath(volume, chapter));
  }

  indexPath(slug: VolumeSlug): string {
    return join(this.volumeDir(slug), "index.json");
  }

  /** Corpus-wide index, spanning every volume. Sibling to `volumes/`, not inside any single volume's directory. */
  corpusIndexPath(): string {
    return join(this.root, "index.json");
  }

  evidenceDir(slug: VolumeSlug): string {
    return join(this.volumeDir(slug), "evidence");
  }
}
