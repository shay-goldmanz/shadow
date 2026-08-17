/**
 * An in-memory implementation of `ShadowApiClient`. This is what the app is
 * built and tested against — `@shadow/api` may be unavailable in a given
 * dev environment, and this fake is the stand-in. `bun run dev` also serves
 * the SPA wired to this client, seeded with `fake-data.ts`, so the whole
 * app is inspectable without a server.
 */

import type { GetSessionEventsOptions, ShadowApiClient } from "./client.ts";
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
  type SessionEventEnvelope,
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

/** A `getSessionEvents` subscriber — pushed to synchronously (`recordSessionEvent`/`publishTextDelta`), exactly like the real `SessionEventBus` (`@shadow/api`'s `session-bus.ts`): this stand-in is single-threaded JS, so "subscribe, then read the log" (below) can never miss an event the way an actually-concurrent bus could without the real one's bus-first-buffer care. */
type SessionEventListener = (message: SessionBusMessage) => void;

/** Every STORED (record-kind) event this fake logs/publishes carries a REAL `seq` (stamped the instant it's recorded) — narrower than the public `SessionEventEnvelope` (`seq: number | undefined`). Kept distinct so the internal log never has to juggle a possibly-`undefined` seq it never actually produces; `getSessionEvents` widens back to `SessionEventEnvelope`, folding `seq` into `data` too (mirroring the real wire's `withSeq`), only at its own yield points. */
interface StoredEnvelope {
  readonly event: SessionEventEnvelope["event"];
  readonly data: unknown;
  readonly seq: number;
}

/**
 * F2/F4/F9 review fix — mirrors `@shadow/api`'s own `SessionBusMessage`
 * (`session-bus.ts`): a two-case union, not just `StoredEnvelope`, so a live
 * `text` delta (no stored shape, no `seq` — this fake's `chatScript` events
 * ARE the wire shape already, unlike the real server which derives them
 * from raw `ShadowEvent`s, but the seq-carrying-vs-not distinction is
 * identical either way) can flow to a follow subscriber without being
 * confused for the one stored `text` event that carries a completed
 * message's FULL accumulated text. See `chat()`'s doc for how the two are
 * told apart from a script that only ever writes individual delta chunks.
 */
type SessionBusMessage =
  | { readonly kind: "record"; readonly envelope: StoredEnvelope }
  | { readonly kind: "text-delta"; readonly data: unknown };

/** Folds `seq` into `data` (mirroring `@shadow/api`'s `withSeq`) for a stored, record-kind event's public `SessionEventEnvelope` shape — every consumer (both real and fake clients) reads `data.seq`, not the envelope's own `seq` field, to tell a full-text `text` apart from a live delta (`../pages/chat-transcript.ts`'s `"text"` case doc). */
function withSeqData(data: unknown, seq: number): unknown {
  return typeof data === "object" && data !== null
    ? { ...(data as Record<string, unknown>), seq }
    : data;
}

export class FakeApiClient implements ShadowApiClient {
  private readonly volumes = new Map<string, SeedVolume>();
  private readonly streamDelayMs: number;
  private readonly chatScript: (sessionId: string, input: ChatInput) => readonly ChatStreamEvent[];
  private nextSessionId = 1;
  /**
   * Per-session stand-in for `@shadow/sessions`' `events.jsonl` — every
   * event `recordSessionEvent` stamps with a monotonic `seq`, mirroring
   * `@shadow/api`'s `event-mapping.ts`/`session-events.ts`. `session` (a
   * `POST /api/chat`-only synthetic, minted at enqueue time, never stored)
   * and `done` (never stored either — `?follow=true` never sends it at all,
   * and plain replay synthesizes it fresh once the stored transcript is
   * exhausted, per `getSessionEvents` below) are never logged, matching the
   * real server's own `StoredSessionEvent` union having no shape for
   * either. Neither is an individual `text` DELTA (F2/F4 review fix — see
   * `chat()`'s doc): only the FULL text `chat()` accumulates from a run of
   * consecutive delta chunks is ever logged here, one entry per run, the
   * same way `@shadow/sessions` only ever stores one `assistant-message`
   * record per contiguous run of deltas, never the deltas themselves. `done`
   * itself is instead logged as a synthetic `turn.ended` entry (F3 review
   * fix) — this fake's stand-in for the real `turn-boundary(ended,
   * completed)` record now getting its own wire representation.
   */
  private readonly sessionLogs = new Map<string, StoredEnvelope[]>();
  private readonly sessionSeqs = new Map<string, number>();
  private readonly sessionListeners = new Map<string, Set<SessionEventListener>>();

  constructor(options: FakeApiClientOptions = {}) {
    for (const seed of options.volumes ?? [seedVolume()]) {
      this.volumes.set(seed.volume.slug, seed);
    }
    this.streamDelayMs = options.streamDelayMs ?? 0;
    this.chatScript =
      options.chatScript ?? ((sessionId, input) => defaultChatScript(sessionId, input));
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

  /**
   * F2/F4/F9 review fix: consecutive `text` events in the script are
   * treated as one message's delta chunks, exactly like `@shadow/agent`
   * yielding several `text-delta` `ShadowEvent`s before its one
   * `assistant-message` (`packages/agent/src/conversation.ts`'s
   * `runModelTurn`/`sendMessage`). Each chunk is published live (a
   * transient `text-delta` bus message, no `seq`, never logged) as it's
   * yielded to THIS call's own consumer; once a run of `text` events ends
   * (the next scripted event isn't `"text"`, or the script itself ends),
   * the accumulated full string is recorded as ONE stored, `seq`-stamped
   * `text` entry — the fake's stand-in for the real `assistant-message`
   * record. `done` itself becomes a stored `turn.ended` entry instead of
   * being skipped (F3 review fix) — this fake's stand-in for
   * `turn-boundary(ended, completed)`, which now gets a wire
   * representation on the real server too.
   */
  async *chat(input: ChatInput): AsyncIterable<ChatStreamEvent> {
    const sessionId = input.sessionId ?? `sess_${this.nextSessionId++}`;
    let pendingText = "";
    const flushPendingText = (): void => {
      if (pendingText === "") return;
      this.recordSessionEvent(sessionId, { event: "text", data: { delta: pendingText } });
      pendingText = "";
    };
    for (const event of this.chatScript(sessionId, input)) {
      if (this.streamDelayMs > 0) await sleep(this.streamDelayMs);
      if (event.event === "text") {
        pendingText += event.data.delta;
        this.publishTextDelta(sessionId, event.data);
        yield event;
        continue;
      }
      flushPendingText();
      if (event.event === "session") {
        yield event;
        continue;
      }
      if (event.event === "done") {
        this.recordSessionEvent(sessionId, { event: "turn.ended", data: {} });
        yield event;
        continue;
      }
      this.recordSessionEvent(sessionId, event);
      yield event;
    }
  }

  /** Stamps + stores + publishes one record-kind event for `getSessionEvents` — every scripted event EXCEPT `session`/`done`/individual `text` deltas (see `chat()`'s doc for how those three are handled instead). */
  private recordSessionEvent(sessionId: string, event: { event: string; data: unknown }): void {
    const seq = (this.sessionSeqs.get(sessionId) ?? 0) + 1;
    this.sessionSeqs.set(sessionId, seq);
    const envelope: StoredEnvelope = {
      event: event.event as SessionEventEnvelope["event"],
      data: event.data,
      seq,
    };
    const log = this.sessionLogs.get(sessionId);
    if (log) {
      log.push(envelope);
    } else {
      this.sessionLogs.set(sessionId, [envelope]);
    }
    const message: SessionBusMessage = { kind: "record", envelope };
    for (const listener of this.sessionListeners.get(sessionId) ?? []) {
      listener(message);
    }
  }

  /** Publishes one live `text` delta chunk to `sessionId`'s follow subscribers ONLY — never logged (mirrors `@shadow/sessions` never storing `text-delta` `ShadowEvent`s at all). */
  private publishTextDelta(sessionId: string, data: unknown): void {
    const message: SessionBusMessage = { kind: "text-delta", data };
    for (const listener of this.sessionListeners.get(sessionId) ?? []) {
      listener(message);
    }
  }

  async *getSessionEvents(
    sessionId: string,
    options: GetSessionEventsOptions = {},
  ): AsyncIterable<SessionEventEnvelope> {
    const fromSeq = options.fromSeq ?? 1;

    // Bus-first-buffer (mirrors `@shadow/api`'s `session-events.ts`, even
    // though single-threaded JS makes the race it guards against
    // unreachable here — same shape either way, so a caller can't tell
    // this fake apart from the real endpoint by relying on ordering).
    const buffered: SessionBusMessage[] = [];
    let wake: (() => void) | undefined;
    const listener: SessionEventListener | undefined = options.follow
      ? (message) => {
          buffered.push(message);
          wake?.();
        }
      : undefined;
    if (listener) {
      const listeners = this.sessionListeners.get(sessionId) ?? new Set();
      listeners.add(listener);
      this.sessionListeners.set(sessionId, listeners);
    }

    try {
      let lastSeq = fromSeq - 1;
      for (const envelope of this.sessionLogs.get(sessionId) ?? []) {
        if (envelope.seq < fromSeq) continue;
        yield {
          event: envelope.event,
          data: withSeqData(envelope.data, envelope.seq),
          seq: envelope.seq,
        };
        lastSeq = envelope.seq;
      }

      if (!options.follow) {
        yield { event: "done", data: {}, seq: undefined };
        return;
      }

      for (;;) {
        while (buffered.length > 0) {
          const next = buffered.shift();
          if (!next) continue;
          if (next.kind === "text-delta") {
            // Never dedup'd by seq — it has none, same as the real endpoint
            // (`../../api/src/handlers/session-events.ts`'s module doc).
            yield { event: "text", data: next.data, seq: undefined };
            continue;
          }
          if (next.envelope.seq <= lastSeq) continue; // already delivered above — dedup by seq, same as the real endpoint
          lastSeq = next.envelope.seq;
          yield {
            event: next.envelope.event,
            data: withSeqData(next.envelope.data, next.envelope.seq),
            seq: next.envelope.seq,
          };
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    } finally {
      if (listener) {
        this.sessionListeners.get(sessionId)?.delete(listener);
      }
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
