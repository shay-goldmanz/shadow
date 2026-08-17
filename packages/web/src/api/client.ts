/**
 * The single port `@shadow/web` uses to reach the outside world. Every
 * network access in this app goes through an implementation of this
 * interface — no component fetches directly. That is what makes the app
 * testable against a fake and swappable onto a real `@shadow/api` server
 * without touching a single component.
 */

import type {
  AuditRecord,
  Chapter,
  ChapterSummary,
  ChatInput,
  ChatStreamEvent,
  ClaimSidecar,
  CreateVolumeInput,
  IndexStats,
  LedgerEvent,
  LintReport,
  PutChapterAudit,
  PutChapterInput,
  SessionEventEnvelope,
  SourceRecord,
  UpdateVolumeInput,
  Volume,
  VolumeIndexDocument,
  VolumeSummary,
} from "./types.ts";

/** `getSessionEvents`'s options — `?follow=`/`?fromSeq=` (T2.7). */
export interface GetSessionEventsOptions {
  /** `?follow=true` — stay open past the stored transcript and stream live activity too (including turns from other tabs). @default false (replay only, ends with a `done` event). */
  readonly follow?: boolean;
  /** `?fromSeq=` — the reconnect cursor. Inclusive: the record it names IS re-delivered (`SessionStore.readEvents`'s contract) — a client resuming after `seq` N passes `N + 1`. @default undefined (replay the whole stored transcript). */
  readonly fromSeq?: number;
}

export interface ShadowApiClient {
  listVolumes(): Promise<readonly VolumeSummary[]>;
  createVolume(input: CreateVolumeInput): Promise<Volume>;
  getVolume(slug: string): Promise<{ volume: Volume; chapters: readonly ChapterSummary[] }>;
  updateVolume(slug: string, input: UpdateVolumeInput): Promise<Volume>;
  deleteVolume(slug: string): Promise<void>;

  getChapter(
    slug: string,
    chapter: string,
  ): Promise<{ chapter: Chapter; claims?: ClaimSidecar; audit?: AuditRecord }>;
  putChapter(
    slug: string,
    chapter: string,
    input: PutChapterInput,
  ): Promise<{ chapter: Chapter; audit: PutChapterAudit }>;
  deleteChapter(slug: string, chapter: string): Promise<void>;

  /** @throws {ApiError} with code `index_not_built` if the volume has never been indexed — a normal state for a freshly created volume, not a fault. */
  getIndex(slug: string): Promise<VolumeIndexDocument>;
  reindex(slug: string): Promise<{ index: VolumeIndexDocument; stats: IndexStats }>;
  getLint(slug: string): Promise<LintReport>;

  getSource(slug: string, id: string): Promise<SourceRecord>;
  getSnapshot(slug: string, hash: string): Promise<string>;
  getLedger(slug: string): Promise<{ events: readonly LedgerEvent[] }>;

  /** Streams one chat turn. Consume with `for await`; the async iterable ends after `done` or `error`. */
  chat(input: ChatInput): AsyncIterable<ChatStreamEvent>;

  /**
   * `GET /api/sessions/:id/events` (T2.7/T2.8) — replay a session's stored
   * transcript, optionally (`options.follow`) staying open to stream live
   * activity afterward, from any tab (this one's own sends included). With
   * `follow: true` the returned iterable never completes on its own; the
   * caller must `break`/`return` out of its `for await` (or otherwise stop
   * pulling) to disconnect.
   */
  getSessionEvents(
    sessionId: string,
    options?: GetSessionEventsOptions,
  ): AsyncIterable<SessionEventEnvelope>;
}
