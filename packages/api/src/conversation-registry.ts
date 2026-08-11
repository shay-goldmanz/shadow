/**
 * Bounded, LRU-evicting registry for live `ShadowConversation`s
 * (`ApiDeps.conversations`, `handlers/chat.ts`'s `Map<sessionId,
 * ShadowConversation>` — now this instead of a raw `Map`).
 *
 * Every conversation now persists its underlying `AgenticSession`'s
 * transcript on disk for the life of the handle (session persistence is
 * required for D6's multi-turn `resume` to work at all — see
 * `@shadow/agent`'s `conversation.ts`), so an unbounded registry isn't just
 * an in-memory leak, it accumulates real files under `~/.claude/projects/`.
 * `ShadowConversation.dispose()` releases that; this class is what actually
 * calls it, on two paths:
 *   - eviction: the registry holds at most `maxSize` conversations. Inserting
 *     past that cap evicts and disposes the least-recently-used one.
 *   - shutdown: `disposeAll()` (`start.ts` on `SIGINT`/`SIGTERM`) disposes
 *     everything still held.
 *
 * Deliberately simple — this is a local, single-operator prototype. An idle
 * timeout would also bound growth but needs a timer per entry and a clock
 * to fake in tests; a size-capped LRU needs neither and is bounded the same
 * way. "Least-recently-*resumed*" (touched on `get`, not just `set`) is what
 * makes the cap track actual usage rather than just insertion order.
 */

import type { ShadowConversation } from "@shadow/agent";

export interface ConversationRegistryOptions {
  /** Conversations held before the least-recently-used one is evicted and disposed. @default 50 */
  readonly maxSize?: number;
}

export class ConversationRegistry {
  private readonly maxSize: number;
  private readonly byId = new Map<string, ShadowConversation>();

  constructor(options: ConversationRegistryOptions = {}) {
    this.maxSize = options.maxSize ?? 50;
  }

  get size(): number {
    return this.byId.size;
  }

  get(sessionId: string): ShadowConversation | undefined {
    const conversation = this.byId.get(sessionId);
    if (!conversation) return undefined;
    // Touch: delete-then-reinsert moves it to the most-recently-used end —
    // a `Map` iterates in insertion order, so the oldest entry is always
    // whatever `.keys().next()` yields.
    this.byId.delete(sessionId);
    this.byId.set(sessionId, conversation);
    return conversation;
  }

  set(sessionId: string, conversation: ShadowConversation): void {
    this.byId.set(sessionId, conversation);
    this.evictOverflow();
  }

  private evictOverflow(): void {
    while (this.byId.size > this.maxSize) {
      const oldestId = this.byId.keys().next().value;
      if (oldestId === undefined) break;
      const oldest = this.byId.get(oldestId);
      this.byId.delete(oldestId);
      void oldest?.dispose().catch(() => {
        // Best-effort: an already-gone/never-started session's dispose
        // failing must not take the registry (or the request that
        // triggered this eviction) down with it.
      });
    }
  }

  /** Dispose every held conversation and empty the registry — server shutdown. */
  async disposeAll(): Promise<void> {
    const conversations = [...this.byId.values()];
    this.byId.clear();
    await Promise.all(conversations.map((conversation) => conversation.dispose().catch(() => {})));
  }
}
