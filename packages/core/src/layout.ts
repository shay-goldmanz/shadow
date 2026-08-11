/**
 * Owns the on-disk layout described in `ARCHITECTURE.md`:
 *
 * ```
 * <root>/volumes/<volume-slug>/
 *   volume.json
 *   chapters/<chapter-slug>.md
 *   index.json
 *   evidence/
 * ```
 *
 * This is the *only* place in the whole codebase that joins a slug onto a
 * path. `FileSystemVolumeStore` is the only consumer. Every method
 * re-validates its slug arguments via `toVolumeSlug`/`toChapterSlug` even
 * though the parameter types are already branded — the brand can be
 * defeated by an unsafe cast (`"../x" as VolumeSlug`) anywhere upstream,
 * and this is the security boundary where that must not matter.
 */

import { join } from "node:path";
import { type ChapterSlug, toChapterSlug, toVolumeSlug, type VolumeSlug } from "./slug.ts";

export class VolumeLayout {
  constructor(private readonly root: string) {}

  volumesDir(): string {
    return join(this.root, "volumes");
  }

  volumeDir(slug: VolumeSlug): string {
    return join(this.volumesDir(), toVolumeSlug(slug));
  }

  volumeMetaPath(slug: VolumeSlug): string {
    return join(this.volumeDir(slug), "volume.json");
  }

  chaptersDir(slug: VolumeSlug): string {
    return join(this.volumeDir(slug), "chapters");
  }

  chapterPath(volume: VolumeSlug, chapter: ChapterSlug): string {
    return join(this.chaptersDir(volume), `${toChapterSlug(chapter)}.md`);
  }

  indexPath(slug: VolumeSlug): string {
    return join(this.volumeDir(slug), "index.json");
  }

  evidenceDir(slug: VolumeSlug): string {
    return join(this.volumeDir(slug), "evidence");
  }
}
