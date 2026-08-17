/**
 * The `SessionStore` port — the storage contract every caller (today:
 * nobody yet; from T2.5 onward, `@shadow/api`'s `SessionService`) depends
 * on instead of the filesystem. `FileSystemSessionStore`
 * (`filesystem-session-store.ts`) is the real implementation;
 * `test-helpers.ts`'s `InMemorySessionStore` is a fake satisfying the same
 * contract suite (`session-store.contract.ts`).
 *
 * A session is one `~/.shadow/sessions/<id>/` directory: `meta.json`
 * (the row) plus `events.jsonl` (the append-only transcript, replay
 * cursor `seq`). See `events.ts` for `StoredSessionEvent`.
 */

import type { VolumeSlug } from "@shadow/core";
import type { StoredSessionEvent } from "./events.ts";

/**
 * One session's row. `sdkSessionId` starts unset — a session exists (has
 * been `create`d) before its first model turn has ever completed, e.g.
 * the moment `SessionService.enqueueTurn` mints an id — and is written via
 * `update` once the SDK hands one back.
 */
export interface SessionMeta {
  readonly id: string;
  readonly volume: VolumeSlug;
  readonly title: string | null;
  /** ISO-8601. Set once, at `create`, and never changed after. */
  readonly createdAt: string;
  /** ISO-8601. Bumped by `update` on every turn (T2.5). */
  readonly lastActiveAt: string;
  /** Set once the first turn completes (T2.5); absent (not `null`) until then, so it round-trips through `JSON.stringify` as a genuinely missing key rather than a stored `null`. */
  readonly sdkSessionId?: string;
}

/**
 * `update`'s patch. Only these three fields are ever mutable after
 * `create` — everything else about a `SessionMeta` (`id`, `volume`,
 * `createdAt`) is fixed for the session's lifetime.
 *
 * `title` follows the same omitted-vs-`null` convention as `@shadow/core`'s
 * `VolumeUpdate.staleAfter`: a key left out of the patch entirely
 * (`undefined`) means "don't touch it", while an explicit `null` clears
 * the title back to untitled. `lastActiveAt`/`sdkSessionId` have no
 * "clear" case — an absent key simply means "don't touch it" and there is
 * no way to unset either once set.
 */
export interface SessionMetaPatch {
  readonly title?: string | null;
  readonly lastActiveAt?: string;
  readonly sdkSessionId?: string;
}

/** One entry in a session's transcript, as read back. `seq` is the replay cursor: strictly increasing per session, assigned by `append`, never reused or renumbered. */
export interface StoredEventRecord {
  readonly seq: number;
  readonly turnId: string;
  /** ISO-8601, when this event was recorded (not necessarily when the underlying agent event was produced — the store stamps it at append time). */
  readonly at: string;
  readonly event: StoredSessionEvent;
}

/** What a caller passes to `append` — everything about a `StoredEventRecord` except `seq`, which only the store may assign. */
export type NewStoredEvent = Omit<StoredEventRecord, "seq">;

export interface SessionListFilter {
  readonly volume?: VolumeSlug;
}

export interface SessionStore {
  /** @throws {SessionAlreadyExistsError} if `meta.id` already has a session on disk. */
  create(meta: SessionMeta): Promise<void>;

  /** `undefined` if `id` has no session — a soft miss, not an error, so a caller (e.g. T2.5's registry-then-store lookup) can chain it into a 404 without a `try`/`catch`. */
  get(id: string): Promise<SessionMeta | undefined>;

  /**
   * Sessions newest-first: ordered by `lastActiveAt` descending (a session
   * that was just turned on jumps to the top, matching the "resume" list
   * T3.2 renders), ties broken by `createdAt` descending then `id`
   * ascending for a fully deterministic order. Empty array if none exist
   * (or none match `filter.volume`).
   */
  list(filter?: SessionListFilter): Promise<SessionMeta[]>;

  /** @throws {SessionNotFoundError} if `id` has no session on disk. */
  update(id: string, patch: SessionMetaPatch): Promise<void>;

  /**
   * Append one or more events to the session's transcript in a single
   * batch, atomically with respect to `seq` assignment — every record in
   * `events` gets the next `seq` in order, so a batch is never
   * interleaved with another caller's `append` mid-batch. Returns the
   * same records, `seq`-stamped, in the order given.
   *
   * **Not a substitute for external serialization.** This store assumes
   * at most one `append` (and no concurrent `readEvents`-during-repair) is
   * in flight per session id at a time — the guarantee `@shadow/api`'s
   * `SessionService` provides via its per-session-id async lock (T2.5).
   * Two truly concurrent `append` calls for the same id from two callers
   * that skip that lock can race on `seq` assignment; this port does not
   * defend against that itself.
   *
   * @throws {SessionNotFoundError} if `id` has no session on disk.
   */
  append(id: string, events: readonly NewStoredEvent[]): Promise<StoredEventRecord[]>;

  /**
   * The transcript in `seq` order. `fromSeq`, when given, returns only
   * records with `seq >= fromSeq` (inclusive) — the reconnect cursor T2.7's
   * replay+follow endpoint uses (`?fromSeq=`). Tolerates a torn last line
   * of `events.jsonl` (returns the readable prefix, does not throw) — see
   * `SessionEventsCorruptError`'s doc for why that specific shape of
   * corruption is treated as an expected crash artifact rather than a
   * failure.
   *
   * @throws {SessionNotFoundError} if `id` has no session on disk.
   * @throws {SessionEventsCorruptError} if a line *other than the last* is malformed.
   */
  readEvents(id: string, fromSeq?: number): Promise<StoredEventRecord[]>;

  /**
   * Removes the session's directory (`meta.json` + `events.jsonl`) only.
   * Deleting the underlying SDK transcript (`~/.claude/projects/<sdkSessionId>`)
   * is deliberately **not** this method's job — that requires the
   * id-based `deleteStoredSession` port `@shadow/model` grows in T2.4, and
   * is driven from `meta.sdkSessionId` by the DELETE endpoint in T3.1,
   * which can call this `delete` and that port together. Keeping them
   * separate here is what lets T2.4's cold-session deletion (no live
   * `AgenticSession` handle, store-only) reuse this method unchanged.
   *
   * @throws {SessionNotFoundError} if `id` has no session on disk.
   */
  delete(id: string): Promise<void>;
}
