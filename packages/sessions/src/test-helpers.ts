/**
 * Test-only helpers, not part of the public surface (not re-exported from
 * `index.ts`) — imported directly via the `@shadow/sessions/test-helpers`
 * subpath (the package's `"./*"` export), the same convention
 * `@shadow/core`, `@shadow/evidence`, and `@shadow/agent` use for their
 * own `test-helpers.ts`.
 *
 * `InMemorySessionStore` is the in-memory fake T2.1 requires alongside
 * `FileSystemSessionStore` — both pass `session-store.contract.ts`'s
 * shared suite (see `in-memory-session-store.test.ts`), and later tiers
 * (T2.5's `SessionService` tests, in `@shadow/api`) can use it directly
 * instead of a temp-dir-backed filesystem store.
 */

import { expect } from "bun:test";
import { SessionAlreadyExistsError, SessionNotFoundError } from "./errors.ts";
import type {
  NewStoredEvent,
  SessionListFilter,
  SessionMeta,
  SessionMetaPatch,
  SessionStore,
  StoredEventRecord,
} from "./session-store.ts";

// biome-ignore lint/suspicious/noExplicitAny: constructor signatures are inherently heterogeneous
type ErrorConstructor<E> = new (...args: any[]) => E;

/** Await `promise`, assert it rejects, and assert the rejection is an instance of `ctor`. Returns the rejection. Sidesteps oxlint's type-aware `await-thenable` rule the way `@shadow/core`'s identically-named helper does. */
export async function expectRejection<E>(
  promise: Promise<unknown>,
  ctor: ErrorConstructor<E>,
): Promise<E> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ctor);
    return error as E;
  }
  return expect.unreachable(`expected promise to reject with ${ctor.name}, but it resolved`);
}

/** Deep-clones through a JSON round-trip — every type in this package (`SessionMeta`, `StoredEventRecord`) is plain JSON-serializable data, so this is exactly what the filesystem store's own `Bun.write`/`file.json()` round-trip does. Cloning on both store and retrieve keeps this fake honest: a caller mutating a returned object (or an object it passed in) can never reach back into the fake's internal state, matching the isolation a real filesystem store gets for free. */
function cloneThroughJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface SessionRecord {
  meta: SessionMeta;
  events: StoredEventRecord[];
}

/**
 * In-memory fake for `SessionStore` — no filesystem, no process to crash,
 * so it deliberately does not (and cannot meaningfully) model the
 * torn-tail crash tolerance `filesystem-session-store.test.ts` exercises
 * separately; see `session-store.contract.ts`'s module doc for why that
 * stays out of the shared contract suite.
 */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  async create(meta: SessionMeta): Promise<void> {
    if (this.sessions.has(meta.id)) {
      throw new SessionAlreadyExistsError(meta.id);
    }
    this.sessions.set(meta.id, { meta: cloneThroughJson(meta), events: [] });
  }

  async get(id: string): Promise<SessionMeta | undefined> {
    const record = this.sessions.get(id);
    return record ? cloneThroughJson(record.meta) : undefined;
  }

  async list(filter?: SessionListFilter): Promise<SessionMeta[]> {
    const metas = [...this.sessions.values()].map((record) => cloneThroughJson(record.meta));
    const filtered =
      filter?.volume !== undefined ? metas.filter((meta) => meta.volume === filter.volume) : metas;
    filtered.sort((a, b) => {
      if (a.lastActiveAt !== b.lastActiveAt) {
        return a.lastActiveAt < b.lastActiveAt ? 1 : -1;
      }
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? 1 : -1;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return filtered;
  }

  async update(id: string, patch: SessionMetaPatch): Promise<void> {
    const record = this.sessions.get(id);
    if (!record) {
      throw new SessionNotFoundError(id);
    }
    record.meta = {
      ...record.meta,
      title: patch.title !== undefined ? patch.title : record.meta.title,
      lastActiveAt: patch.lastActiveAt ?? record.meta.lastActiveAt,
      sdkSessionId: patch.sdkSessionId ?? record.meta.sdkSessionId,
      failedSdkSessionIds: patch.failedSdkSessionIds ?? record.meta.failedSdkSessionIds,
    };
  }

  async append(id: string, events: readonly NewStoredEvent[]): Promise<StoredEventRecord[]> {
    const record = this.sessions.get(id);
    if (!record) {
      throw new SessionNotFoundError(id);
    }
    const lastExisting =
      record.events.length > 0 ? record.events[record.events.length - 1] : undefined;
    let seq = lastExisting?.seq ?? 0;
    const stamped: StoredEventRecord[] = events.map((event) => {
      seq += 1;
      return cloneThroughJson({ ...event, seq });
    });
    record.events.push(...stamped);
    return stamped.map(cloneThroughJson);
  }

  async readEvents(id: string, fromSeq?: number): Promise<StoredEventRecord[]> {
    const record = this.sessions.get(id);
    if (!record) {
      throw new SessionNotFoundError(id);
    }
    const records = record.events.map(cloneThroughJson);
    return fromSeq === undefined ? records : records.filter((r) => r.seq >= fromSeq);
  }

  async delete(id: string): Promise<void> {
    if (!this.sessions.has(id)) {
      throw new SessionNotFoundError(id);
    }
    this.sessions.delete(id);
  }
}
