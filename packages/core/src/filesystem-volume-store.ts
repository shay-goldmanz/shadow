import type { Dirent } from "node:fs";
import { mkdir, readdir, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ChapterNotFoundError, VolumeAlreadyExistsError, VolumeNotFoundError } from "./errors.ts";
import { parseChapterDocument, serializeChapterDocument } from "./frontmatter.ts";
import { VolumeLayout } from "./layout.ts";
import type { ChapterSlug, VolumeSlug } from "./slug.ts";
import { isValidChapterSlug, isValidVolumeSlug, toChapterSlug, toVolumeSlug } from "./slug.ts";
import type { Chapter, ChapterInput, Volume, VolumeInput, VolumeUpdate } from "./types.ts";
import { parseVolumeDocument, serializeVolumeDocument } from "./volume-frontmatter.ts";
import type { VolumeStore } from "./volume-store.ts";

/**
 * Legacy on-disk shape of `volume.json`, from before `VOLUME.md` existed.
 * Dates are ISO strings; everything else matches `Volume` minus
 * `frontmatter`, which legacy volumes don't have (treated as `{}` on read).
 * Still read for backward compatibility; never written by this version.
 */
interface VolumeRecord {
  slug: string;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** Swallow ENOENT (the directory doesn't exist yet); rethrow everything else. */
async function readdirOrEmpty(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * Filesystem implementation of `VolumeStore`. Owns the on-disk layout
 * defined in `layout.ts` — nothing outside this class ever sees `root` or
 * builds a path into it.
 */
export class FileSystemVolumeStore implements VolumeStore {
  private readonly layout: VolumeLayout;

  /** @param root Storage root. Defaults to `~/.shadow` (see D4). */
  constructor(root: string = join(homedir(), ".shadow")) {
    this.layout = new VolumeLayout(root);
  }

  // ---- volumes --------------------------------------------------------

  async createVolume(input: VolumeInput): Promise<Volume> {
    if (await this.volumeRecordExists(input.slug)) {
      throw new VolumeAlreadyExistsError(input.slug);
    }
    const now = new Date();
    const volume: Volume = {
      slug: input.slug,
      title: input.title,
      description: input.description ?? "",
      frontmatter: input.frontmatter ?? {},
      createdAt: now,
      updatedAt: now,
    };
    await this.writeVolumeRecord(volume);
    return volume;
  }

  async getVolume(slug: VolumeSlug): Promise<Volume> {
    return this.readVolumeRecord(slug);
  }

  async listVolumes(): Promise<Volume[]> {
    const entries = await readdirOrEmpty(this.layout.volumesDir());
    const volumes: Volume[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidVolumeSlug(entry.name)) {
        continue;
      }
      try {
        volumes.push(await this.readVolumeRecord(toVolumeSlug(entry.name)));
      } catch (error) {
        // A directory without a volume.json is not a volume (e.g. a
        // partially-cleaned-up delete). Skip it rather than fail the listing.
        if (error instanceof VolumeNotFoundError) {
          continue;
        }
        throw error;
      }
    }
    volumes.sort((a, b) => a.slug.localeCompare(b.slug));
    return volumes;
  }

  async updateVolume(slug: VolumeSlug, patch: VolumeUpdate): Promise<Volume> {
    const existing = await this.readVolumeRecord(slug);
    const updated: Volume = {
      ...existing,
      title: patch.title ?? existing.title,
      description: patch.description ?? existing.description,
      frontmatter: patch.frontmatter ?? existing.frontmatter,
      updatedAt: new Date(),
    };
    await this.writeVolumeRecord(updated);
    return updated;
  }

  async deleteVolume(slug: VolumeSlug): Promise<void> {
    await this.readVolumeRecord(slug); // throws VolumeNotFoundError if missing
    await rm(this.layout.volumeDir(slug), { recursive: true, force: true });
  }

  // ---- chapters ---------------------------------------------------------

  async putChapter(volume: VolumeSlug, input: ChapterInput): Promise<Chapter> {
    await this.readVolumeRecord(volume); // throws VolumeNotFoundError if missing

    const path = this.layout.chapterPath(volume, input.slug);
    const now = new Date();
    let createdAt = now;

    const existingFile = Bun.file(path);
    if (await existingFile.exists()) {
      const existing = parseChapterDocument(input.slug, await existingFile.text());
      createdAt = existing.createdAt;
    }

    const chapter: Chapter = {
      slug: input.slug,
      title: input.title,
      body: input.body,
      frontmatter: input.frontmatter ?? {},
      createdAt,
      updatedAt: now,
    };
    await Bun.write(path, serializeChapterDocument(chapter));
    return chapter;
  }

  async getChapter(volume: VolumeSlug, chapter: ChapterSlug): Promise<Chapter> {
    await this.readVolumeRecord(volume); // throws VolumeNotFoundError if missing
    return this.readChapterDocument(volume, chapter);
  }

  async listChapters(volume: VolumeSlug): Promise<Chapter[]> {
    await this.readVolumeRecord(volume); // throws VolumeNotFoundError if missing

    const dir = this.layout.chaptersDir(volume);
    const entries = await readdirOrEmpty(dir);
    const chapters: Chapter[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      const candidate = entry.name.slice(0, -".md".length);
      if (!isValidChapterSlug(candidate)) {
        continue;
      }
      const chapterSlug = toChapterSlug(candidate);
      const text = await Bun.file(join(dir, entry.name)).text();
      chapters.push(parseChapterDocument(chapterSlug, text));
    }
    chapters.sort((a, b) => a.slug.localeCompare(b.slug));
    return chapters;
  }

  async deleteChapter(volume: VolumeSlug, chapter: ChapterSlug): Promise<void> {
    await this.readVolumeRecord(volume); // throws VolumeNotFoundError if missing
    const path = this.layout.chapterPath(volume, chapter);
    if (!(await Bun.file(path).exists())) {
      throw new ChapterNotFoundError(volume, chapter);
    }
    await unlink(path);
  }

  // ---- index (opaque to this package) ------------------------------------

  async readIndex<T = unknown>(volume: VolumeSlug): Promise<T | undefined> {
    await this.readVolumeRecord(volume); // throws VolumeNotFoundError if missing
    const file = Bun.file(this.layout.indexPath(volume));
    if (!(await file.exists())) {
      return undefined;
    }
    // Trust boundary: this package stores the index as opaque JSON and does
    // not know its shape. `T` is asserted by the caller (`@shadow/indexing`).
    return (await file.json()) as T;
  }

  async writeIndex(volume: VolumeSlug, index: unknown): Promise<void> {
    await this.readVolumeRecord(volume); // throws VolumeNotFoundError if missing
    await Bun.write(this.layout.indexPath(volume), `${JSON.stringify(index, null, 2)}\n`);
  }

  // ---- corpus-level index (opaque to this package) -----------------------

  async readCorpusIndex<T = unknown>(): Promise<T | undefined> {
    const file = Bun.file(this.layout.corpusIndexPath());
    if (!(await file.exists())) {
      return undefined;
    }
    // Trust boundary: same as readIndex — opaque JSON, shape asserted by
    // the caller (@shadow/indexing).
    return (await file.json()) as T;
  }

  async writeCorpusIndex(index: unknown): Promise<void> {
    await Bun.write(this.layout.corpusIndexPath(), `${JSON.stringify(index, null, 2)}\n`);
  }

  // ---- path resolution (narrow port for @shadow/evidence and others) ----

  evidenceDir(volume: VolumeSlug): string {
    return this.layout.evidenceDir(volume);
  }

  async ensureEvidenceDir(volume: VolumeSlug): Promise<string> {
    await this.readVolumeRecord(volume); // throws VolumeNotFoundError if missing
    const dir = this.layout.evidenceDir(volume);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  chapterRelativePath(volume: VolumeSlug, chapter: ChapterSlug): string {
    return this.layout.chapterRelativePath(volume, chapter);
  }

  // ---- internals ----------------------------------------------------------

  /** Existence check across both the canonical (`VOLUME.md`) and legacy (`volume.json`) formats. */
  private async volumeRecordExists(slug: VolumeSlug): Promise<boolean> {
    if (await Bun.file(this.layout.volumeDocPath(slug)).exists()) {
      return true;
    }
    return Bun.file(this.layout.volumeMetaPath(slug)).exists();
  }

  private async readVolumeRecord(slug: VolumeSlug): Promise<Volume> {
    const docFile = Bun.file(this.layout.volumeDocPath(slug));
    if (await docFile.exists()) {
      return parseVolumeDocument(slug, await docFile.text());
    }

    // Backward compatibility: a volume written before VOLUME.md existed has
    // only volume.json, with no frontmatter concept — treated as `{}`.
    const legacyFile = Bun.file(this.layout.volumeMetaPath(slug));
    if (!(await legacyFile.exists())) {
      throw new VolumeNotFoundError(slug);
    }
    // Trust boundary: volume.json was written only by this package's own
    // (now-retired) writer, so this shape is trusted rather than
    // schema-validated at read time — same posture as the VOLUME.md path.
    const record = (await legacyFile.json()) as VolumeRecord;
    return {
      slug: toVolumeSlug(record.slug),
      title: record.title,
      description: record.description,
      frontmatter: {},
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
    };
  }

  private async writeVolumeRecord(volume: Volume): Promise<void> {
    await Bun.write(this.layout.volumeDocPath(volume.slug), serializeVolumeDocument(volume));
    // Migration cleanup: once VOLUME.md is written, a volume.json left over
    // from before this format existed is stale and would otherwise sit
    // there unread. Best-effort removal — `force: true` no-ops if it was
    // never there, so this never fails create/update on a volume that was
    // already on the new format.
    await rm(this.layout.volumeMetaPath(volume.slug), { force: true });
  }

  private async readChapterDocument(volume: VolumeSlug, chapter: ChapterSlug): Promise<Chapter> {
    const path = this.layout.chapterPath(volume, chapter);
    const file = Bun.file(path);
    if (!(await file.exists())) {
      throw new ChapterNotFoundError(volume, chapter);
    }
    return parseChapterDocument(chapter, await file.text());
  }
}
