import type { Dirent } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { GroupNotFoundError, RulebookAlreadyExistsError, RulebookNotFoundError } from "./errors.ts";
import { parseChapterDocument, serializeChapterDocument } from "./frontmatter.ts";
import { assertNoReservedFrontmatterKeys } from "./frontmatter-shared.ts";
import {
  parseRulebookDocument,
  type Rulebook,
  type RulebookInput,
  serializeRulebookDocument,
} from "./rulebook-frontmatter.ts";
import { RulebookLayout } from "./rulebook-layout.ts";
import type { RulebookStore } from "./rulebook-store.ts";
import {
  type ChapterSlug,
  isValidChapterSlug,
  isValidVolumeSlug,
  toChapterSlug,
  toVolumeSlug,
  type VolumeSlug,
} from "./slug.ts";
import type { Chapter, ChapterInput } from "./types.ts";

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
 * Filesystem implementation of `RulebookStore`. Owns the on-disk layout
 * defined in `rulebook-layout.ts` — nothing outside this class ever sees
 * `root` or builds a path into it. Mirrors `FileSystemVolumeStore`'s grain,
 * with the preserve-on-upsert fix baked in from the start for `putGroup`/
 * `updateRulebook` (see `RulebookStore`'s doc) — a fix deliberately not
 * back-ported to `FileSystemVolumeStore` itself (deferred for now).
 */
export class FileSystemRulebookStore implements RulebookStore {
  private readonly layout: RulebookLayout;

  /** @param root Storage root. Defaults to `~/.shadow` (see `FileSystemVolumeStore`'s D4). */
  constructor(root: string = join(homedir(), ".shadow")) {
    this.layout = new RulebookLayout(root);
  }

  // ---- rule books -----------------------------------------------------------

  async createRulebook(input: RulebookInput): Promise<Rulebook> {
    if (await this.rulebookRecordExists(input.slug)) {
      throw new RulebookAlreadyExistsError(input.slug);
    }
    return this.upsertRulebookRecord(input, undefined);
  }

  async getRulebook(slug: VolumeSlug): Promise<Rulebook> {
    return this.readRulebookRecord(slug);
  }

  async listRulebooks(): Promise<Rulebook[]> {
    const entries = await readdirOrEmpty(this.layout.rulebooksDir());
    const rulebooks: Rulebook[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isValidVolumeSlug(entry.name)) {
        continue;
      }
      try {
        rulebooks.push(await this.readRulebookRecord(toVolumeSlug(entry.name)));
      } catch (error) {
        // A directory without a RULEBOOK.md is not a rule book (e.g. a
        // partially-cleaned-up delete). Skip it rather than fail the listing —
        // matches FileSystemVolumeStore.listVolumes's analogous case.
        if (error instanceof RulebookNotFoundError) {
          continue;
        }
        throw error;
      }
    }
    rulebooks.sort((a, b) => a.slug.localeCompare(b.slug));
    return rulebooks;
  }

  async updateRulebook(input: RulebookInput): Promise<Rulebook> {
    const existing = await this.tryReadRulebookRecord(input.slug);
    return this.upsertRulebookRecord(input, existing);
  }

  // ---- groups -----------------------------------------------------------

  async putGroup(rulebookSlug: VolumeSlug, input: ChapterInput): Promise<Chapter> {
    await this.readRulebookRecord(rulebookSlug); // throws RulebookNotFoundError if missing

    if (input.frontmatter) {
      assertNoReservedFrontmatterKeys(input.frontmatter, "chapter", input.slug);
    }

    const path = this.layout.groupPath(rulebookSlug, input.slug);
    const now = new Date();
    let createdAt = now;
    let existing: Chapter | undefined;

    const existingFile = Bun.file(path);
    if (await existingFile.exists()) {
      existing = parseChapterDocument(input.slug, await existingFile.text());
      createdAt = existing.createdAt;
    }

    const group: Chapter = {
      slug: input.slug,
      title: input.title,
      body: input.body,
      type: input.type ?? existing?.type ?? "Concept",
      status: input.status ?? existing?.status ?? "draft",
      staleAfter:
        input.staleAfter !== undefined ? input.staleAfter : (existing?.staleAfter ?? null),
      generated: input.generated ?? existing?.generated ?? { by: "unknown", at: now },
      verified: input.verified ?? existing?.verified ?? [],
      frontmatter: input.frontmatter ?? existing?.frontmatter ?? {},
      createdAt,
      updatedAt: now,
    };
    await Bun.write(path, serializeChapterDocument(group));
    return group;
  }

  async getGroup(rulebookSlug: VolumeSlug, groupSlug: ChapterSlug): Promise<Chapter> {
    await this.readRulebookRecord(rulebookSlug); // throws RulebookNotFoundError if missing
    return this.readGroupDocument(rulebookSlug, groupSlug);
  }

  async listGroups(rulebookSlug: VolumeSlug): Promise<Chapter[]> {
    await this.readRulebookRecord(rulebookSlug); // throws RulebookNotFoundError if missing

    const dir = this.layout.groupsDir(rulebookSlug);
    const entries = await readdirOrEmpty(dir);
    const groups: Chapter[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      const candidate = entry.name.slice(0, -".md".length);
      if (!isValidChapterSlug(candidate)) {
        continue;
      }
      const groupSlug = toChapterSlug(candidate);
      const text = await Bun.file(join(dir, entry.name)).text();
      groups.push(parseChapterDocument(groupSlug, text));
    }
    groups.sort((a, b) => a.slug.localeCompare(b.slug));
    return groups;
  }

  // ---- extraction cache (opaque to this package) -----------------------

  async readExtractionCache<T = unknown>(rulebookSlug: VolumeSlug, key: string): Promise<T | null> {
    await this.readRulebookRecord(rulebookSlug); // throws RulebookNotFoundError if missing
    const path = this.layout.cacheFilePath(rulebookSlug, key); // throws InvalidSlugError if key is unsafe
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return null;
    }
    // Trust boundary: this package stores the cache as opaque JSON and does
    // not know its shape. `T` is asserted by the caller.
    return (await file.json()) as T;
  }

  async writeExtractionCache(rulebookSlug: VolumeSlug, key: string, value: unknown): Promise<void> {
    await this.readRulebookRecord(rulebookSlug); // throws RulebookNotFoundError if missing
    const path = this.layout.cacheFilePath(rulebookSlug, key); // throws InvalidSlugError if key is unsafe
    await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  // ---- path resolution (narrow port for @shadow/evidence and others) ----

  evidenceDir(rulebook: VolumeSlug): string {
    return this.layout.evidenceDir(rulebook);
  }

  async ensureEvidenceDir(rulebook: VolumeSlug): Promise<string> {
    await this.readRulebookRecord(rulebook); // throws RulebookNotFoundError if missing
    const dir = this.layout.evidenceDir(rulebook);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  chapterRelativePath(rulebook: VolumeSlug, group: ChapterSlug): string {
    return this.layout.chapterRelativePath(rulebook, group);
  }

  // ---- internals ----------------------------------------------------------

  private async rulebookRecordExists(slug: VolumeSlug): Promise<boolean> {
    return Bun.file(this.layout.rulebookDocPath(slug)).exists();
  }

  private async readRulebookRecord(slug: VolumeSlug): Promise<Rulebook> {
    const docFile = Bun.file(this.layout.rulebookDocPath(slug));
    if (!(await docFile.exists())) {
      throw new RulebookNotFoundError(slug);
    }
    return parseRulebookDocument(slug, await docFile.text());
  }

  /** Like `readRulebookRecord`, but returns `undefined` instead of throwing when missing — for `updateRulebook`'s upsert. */
  private async tryReadRulebookRecord(slug: VolumeSlug): Promise<Rulebook | undefined> {
    const docFile = Bun.file(this.layout.rulebookDocPath(slug));
    if (!(await docFile.exists())) {
      return undefined;
    }
    return parseRulebookDocument(slug, await docFile.text());
  }

  /**
   * Shared upsert body for `createRulebook`/`updateRulebook`: hardcoded
   * defaults apply only when `existing` is `undefined` (no rule book on
   * disk yet); otherwise every optional field omitted from `input`
   * preserves `existing`'s current value.
   */
  private async upsertRulebookRecord(
    input: RulebookInput,
    existing: Rulebook | undefined,
  ): Promise<Rulebook> {
    const now = new Date();
    const rulebook: Rulebook = {
      slug: input.slug,
      title: input.title,
      description: input.description ?? existing?.description ?? "",
      type: input.type ?? existing?.type ?? "Rule Book",
      status: input.status ?? existing?.status ?? "draft",
      generated: input.generated ?? existing?.generated ?? { by: "unknown", at: now },
      verified: input.verified ?? existing?.verified ?? [],
      sourceDoc: input.sourceDoc !== undefined ? input.sourceDoc : (existing?.sourceDoc ?? null),
      whenToUse: input.whenToUse ?? existing?.whenToUse,
      notFor: input.notFor ?? existing?.notFor,
      keywords: input.keywords ?? existing?.keywords ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await Bun.write(
      this.layout.rulebookDocPath(rulebook.slug),
      serializeRulebookDocument(rulebook),
    );
    return rulebook;
  }

  private async readGroupDocument(rulebook: VolumeSlug, group: ChapterSlug): Promise<Chapter> {
    const path = this.layout.groupPath(rulebook, group);
    const file = Bun.file(path);
    if (!(await file.exists())) {
      throw new GroupNotFoundError(rulebook, group);
    }
    return parseChapterDocument(group, await file.text());
  }
}
