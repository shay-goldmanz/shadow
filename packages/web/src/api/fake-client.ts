/**
 * An in-memory implementation of `ShadowApiClient`. This is what the app is
 * built and tested against — `docs/API.md` is the contract, `@shadow/api`
 * may not exist yet, and this fake is the stand-in. `bun run dev` also
 * serves the SPA wired to this client, seeded with `fake-data.ts`, so the
 * whole app is inspectable without a server.
 */

import type { ShadowApiClient } from "./client.ts";
import { defaultChatScript } from "./fake-chat-script.ts";
import { chapterSummariesOf, type SeedVolume, seedVolume, volumeSummaryOf } from "./fake-data.ts";
import {
  ApiError,
  type AuditResult,
  type Chapter,
  type ChapterSummary,
  type ChatInput,
  type ChatStreamEvent,
  type Claim,
  type CreateVolumeInput,
  type IndexStats,
  type IndexTree,
  type LedgerEvent,
  type LintReport,
  type PutChapterInput,
  type SourceRecord,
  type UpdateVolumeInput,
  type Volume,
  type VolumeSummary,
} from "./types.ts";

function slugify(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface FakeApiClientOptions {
  readonly volumes?: readonly SeedVolume[];
  /** Delay between streamed chat events, for a realistic demo feel. 0 in tests. */
  readonly streamDelayMs?: number;
  /** Overrides the scripted chat turn. Defaults to the critical-path narration. */
  readonly chatScript?: (sessionId: string, input: ChatInput) => readonly ChatStreamEvent[];
}

export class FakeApiClient implements ShadowApiClient {
  private readonly volumes = new Map<string, SeedVolume>();
  private readonly streamDelayMs: number;
  private readonly chatScript: (sessionId: string, input: ChatInput) => readonly ChatStreamEvent[];
  private nextSessionId = 1;

  constructor(options: FakeApiClientOptions = {}) {
    for (const seed of options.volumes ?? [seedVolume()]) {
      this.volumes.set(seed.volume.slug, seed);
    }
    this.streamDelayMs = options.streamDelayMs ?? 0;
    this.chatScript = options.chatScript ?? ((sessionId) => defaultChatScript(sessionId));
  }

  async listVolumes(): Promise<readonly VolumeSummary[]> {
    return [...this.volumes.values()].map(volumeSummaryOf);
  }

  async createVolume(input: CreateVolumeInput): Promise<Volume> {
    const slug = input.slug ?? slugify(input.title);
    if (this.volumes.has(slug)) {
      throw new ApiError("volume_exists", `A volume already exists at slug "${slug}".`);
    }
    if (!slug) {
      throw new ApiError("invalid_slug", "Could not derive a slug from the given title.");
    }
    const now = new Date().toISOString();
    const volume: Volume = {
      slug,
      title: input.title,
      description: input.description ?? "",
      frontmatter: {},
      createdAt: now,
      updatedAt: now,
    };
    this.volumes.set(slug, {
      volume,
      chapters: [],
      index: { volume: slug, generatedAt: now, nodes: [] },
      sources: [],
      snapshots: {},
      ledger: [],
    });
    return volume;
  }

  async getVolume(slug: string): Promise<{ volume: Volume; chapters: readonly ChapterSummary[] }> {
    const seed = this.requireVolume(slug);
    return { volume: seed.volume, chapters: chapterSummariesOf(seed) };
  }

  async updateVolume(slug: string, input: UpdateVolumeInput): Promise<Volume> {
    const seed = this.requireVolume(slug);
    const updated: Volume = {
      ...seed.volume,
      title: input.title ?? seed.volume.title,
      description: input.description ?? seed.volume.description,
      frontmatter: input.frontmatter ?? seed.volume.frontmatter,
      updatedAt: new Date().toISOString(),
    };
    this.volumes.set(slug, { ...seed, volume: updated });
    return updated;
  }

  async deleteVolume(slug: string): Promise<void> {
    this.requireVolume(slug);
    this.volumes.delete(slug);
  }

  async getChapter(
    slug: string,
    chapter: string,
  ): Promise<{ chapter: Chapter; claims?: readonly Claim[]; audit?: AuditResult }> {
    const seed = this.requireVolume(slug);
    const entry = seed.chapters.find((c) => c.chapter.slug === chapter);
    if (!entry) {
      throw new ApiError("chapter_not_found", `No chapter "${chapter}" in volume "${slug}".`);
    }
    return { chapter: entry.chapter, claims: entry.claims, audit: entry.audit };
  }

  async putChapter(
    slug: string,
    chapter: string,
    input: PutChapterInput,
  ): Promise<{ chapter: Chapter; audit: AuditResult }> {
    const seed = this.requireVolume(slug);
    const now = new Date().toISOString();
    const existing = seed.chapters.find((c) => c.chapter.slug === chapter);
    const nextChapter: Chapter = {
      slug: chapter,
      title: input.title,
      body: input.body,
      frontmatter: input.frontmatter ?? existing?.chapter.frontmatter ?? {},
      createdAt: existing?.chapter.createdAt ?? now,
      updatedAt: now,
    };
    const audit: AuditResult = { verdict: "pass", findings: [] };
    const nextEntry = { chapter: nextChapter, claims: existing?.claims ?? [], audit };
    const nextChapters = existing
      ? seed.chapters.map((c) => (c.chapter.slug === chapter ? nextEntry : c))
      : [...seed.chapters, nextEntry];
    this.volumes.set(slug, { ...seed, chapters: nextChapters });
    return { chapter: nextChapter, audit };
  }

  async deleteChapter(slug: string, chapter: string): Promise<void> {
    const seed = this.requireVolume(slug);
    this.volumes.set(slug, {
      ...seed,
      chapters: seed.chapters.filter((c) => c.chapter.slug !== chapter),
    });
  }

  async getIndex(slug: string): Promise<IndexTree> {
    return this.requireVolume(slug).index;
  }

  async reindex(slug: string): Promise<{ index: IndexTree; stats: IndexStats }> {
    const seed = this.requireVolume(slug);
    return {
      index: seed.index,
      stats: { volumes: 1, chapters: seed.chapters.length, tokens: 0 },
    };
  }

  async getLint(slug: string): Promise<LintReport> {
    this.requireVolume(slug);
    return { findings: [] };
  }

  async getSource(slug: string, id: string): Promise<SourceRecord> {
    const seed = this.requireVolume(slug);
    const source = seed.sources.find((s) => s.id === id);
    if (!source) throw new ApiError("source_not_found", `No source "${id}" in volume "${slug}".`);
    return source;
  }

  async getSnapshot(slug: string, hash: string): Promise<string> {
    const seed = this.requireVolume(slug);
    const snapshot = seed.snapshots[hash];
    if (snapshot === undefined) {
      throw new ApiError("snapshot_not_found", `No snapshot "${hash}" in volume "${slug}".`);
    }
    return snapshot;
  }

  async getLedger(slug: string): Promise<{ events: readonly LedgerEvent[] }> {
    return { events: this.requireVolume(slug).ledger };
  }

  async *chat(input: ChatInput): AsyncIterable<ChatStreamEvent> {
    const sessionId = input.sessionId ?? `sess_${this.nextSessionId++}`;
    for (const event of this.chatScript(sessionId, input)) {
      if (this.streamDelayMs > 0) await sleep(this.streamDelayMs);
      yield event;
    }
  }

  private requireVolume(slug: string): SeedVolume {
    const seed = this.volumes.get(slug);
    if (!seed) throw new ApiError("volume_not_found", `No volume at slug "${slug}".`);
    return seed;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
