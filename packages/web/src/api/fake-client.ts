/**
 * An in-memory implementation of `ShadowApiClient`. This is what the app is
 * built and tested against — `@shadow/api` may be unavailable in a given
 * dev environment, and this fake is the stand-in. `bun run dev` also serves
 * the SPA wired to this client, seeded with `fake-data.ts`, so the whole
 * app is inspectable without a server.
 */

import type { ShadowApiClient } from "./client.ts";
import { defaultChatScript } from "./fake-chat-script.ts";
import { chapterSummariesOf, type SeedVolume, seedVolume, volumeSummaryOf } from "./fake-data.ts";
import {
  ApiError,
  type AuditRecord,
  type Chapter,
  type ChapterSummary,
  type ChatInput,
  type ChatStreamEvent,
  type ClaimSidecar,
  type CreateVolumeInput,
  type IndexStats,
  type LedgerEvent,
  type LintReport,
  type PutChapterAudit,
  type PutChapterInput,
  type SourceRecord,
  type UpdateVolumeInput,
  type Volume,
  type VolumeIndexDocument,
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
      throw new ApiError("volume_already_exists", `A volume already exists at slug "${slug}".`);
    }
    if (!slug) {
      throw new ApiError("invalid_slug", "Could not derive a slug from the given title.");
    }
    const now = new Date().toISOString();
    const volume: Volume = {
      slug,
      title: input.title,
      description: input.description ?? "",
      type: "Concept",
      status: "draft",
      staleAfter: null,
      generated: { by: "shadow/1.0", at: now },
      verified: [],
      frontmatter: {},
      createdAt: now,
      updatedAt: now,
    };
    this.volumes.set(slug, {
      volume,
      chapters: [],
      index: {
        schema_version: 1,
        generated_at: now,
        corpus_hash: "sha256:empty",
        volume: {
          volume_id: slug,
          title: volume.title,
          chapter_count: 0,
          volume_hash: "sha256:empty",
          chapters: [],
        },
      },
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
      type: (input.type as string | undefined) ?? seed.volume.type,
      status: (input.status as Volume["status"] | undefined) ?? seed.volume.status,
      staleAfter: (input.staleAfter as string | null | undefined) ?? seed.volume.staleAfter,
      generated: (input.generated as Volume["generated"] | undefined) ?? seed.volume.generated,
      verified: (input.verified as Volume["verified"] | undefined) ?? seed.volume.verified,
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
  ): Promise<{ chapter: Chapter; claims?: ClaimSidecar; audit?: AuditRecord }> {
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
  ): Promise<{ chapter: Chapter; audit: PutChapterAudit }> {
    const seed = this.requireVolume(slug);
    const now = new Date().toISOString();
    const existing = seed.chapters.find((c) => c.chapter.slug === chapter);
    const nextChapter: Chapter = {
      slug: chapter,
      title: input.title,
      body: input.body,
      type: (input.type as string | undefined) ?? existing?.chapter.type ?? "Concept",
      status:
        (input.status as Chapter["status"] | undefined) ?? existing?.chapter.status ?? "draft",
      staleAfter:
        (input.staleAfter as string | null | undefined) ?? existing?.chapter.staleAfter ?? null,
      generated: (input.generated as Chapter["generated"] | undefined) ??
        existing?.chapter.generated ?? { by: "shadow/1.0", at: now },
      verified:
        (input.verified as Chapter["verified"] | undefined) ?? existing?.chapter.verified ?? [],
      frontmatter: input.frontmatter ?? existing?.chapter.frontmatter ?? {},
      createdAt: existing?.chapter.createdAt ?? now,
      updatedAt: now,
    };
    const verdict = { chapter, passed: true, outcomes: [] };
    const audit: AuditRecord = { chapter, auditedAt: now, verdict };
    const claims: ClaimSidecar = existing?.claims ?? {
      schemaVersion: "1.0",
      chapter,
      chapterTextSha256: `sha256:${chapter}`,
      auditedAt: now,
      claims: [],
    };
    const nextEntry = { chapter: nextChapter, claims, audit };
    const nextChapters = existing
      ? seed.chapters.map((c) => (c.chapter.slug === chapter ? nextEntry : c))
      : [...seed.chapters, nextEntry];
    this.volumes.set(slug, { ...seed, chapters: nextChapters });
    return {
      chapter: nextChapter,
      audit: { verdict, outcomes: [], repairs: [], published: true },
    };
  }

  async deleteChapter(slug: string, chapter: string): Promise<void> {
    const seed = this.requireVolume(slug);
    this.volumes.set(slug, {
      ...seed,
      chapters: seed.chapters.filter((c) => c.chapter.slug !== chapter),
    });
  }

  async getIndex(slug: string): Promise<VolumeIndexDocument> {
    const seed = this.requireVolume(slug);
    if (seed.index.volume.chapters.length === 0) {
      // Mirrors the real API: a volume with nothing published yet has no
      // index — `index_not_built`, a normal state, not a fault.
      throw new ApiError("index_not_built", `Volume "${slug}" has not been indexed yet`);
    }
    return seed.index;
  }

  async reindex(slug: string): Promise<{ index: VolumeIndexDocument; stats: IndexStats }> {
    const seed = this.requireVolume(slug);
    return {
      index: seed.index,
      stats: {
        volumes: 1,
        chapters: seed.chapters.length,
        tokens: seed.index.volume.chapters.reduce((sum, c) => sum + c.tokens, 0),
      },
    };
  }

  async getLint(slug: string): Promise<LintReport> {
    this.requireVolume(slug);
    return { findings: [] };
  }

  async getSource(slug: string, id: string): Promise<SourceRecord> {
    const seed = this.requireVolume(slug);
    const src = seed.sources.find((s) => s.id === id);
    if (!src) throw new ApiError("source_not_found", `No source "${id}" in volume "${slug}".`);
    return src;
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
