/**
 * `ConversationRegistry` — T2.4's two behavioral changes: eviction (and
 * shutdown, via `releaseAll`) must release conversations without deleting
 * their SDK transcripts, and eviction must be able to skip a session with a
 * running/queued turn rather than release a handle out from under it. See
 * `conversation-registry.ts`'s module doc for the seam design
 * (`isSessionBusy`, `evict()`) — this suite exercises it directly, with a
 * hand-controlled busy set standing in for T2.5's `SessionService` (which
 * doesn't exist yet).
 *
 * Real `ShadowConversation` instances throughout (`deps.shadowAgent`,
 * `withApi`'s harness) rather than a hand-rolled double: the class has
 * private fields, so nothing else satisfies its type, and using the real
 * thing is what makes test 1 below an honest regression guard for the old
 * `dispose()`-based eviction (it actually drives a turn through
 * `@shadow/model`'s `FakeAgenticSessionPort`, the same fake `close()`
 * deletion was always asserted against).
 */

import { describe, expect, test } from "bun:test";
import type { ShadowConversation } from "@shadow/agent";
import { toVolumeSlug } from "@shadow/core";
import { ConversationRegistry } from "./conversation-registry.ts";
import { seedVolume, withApi } from "./test-helpers.ts";

async function drain(conversation: ShadowConversation, text: string): Promise<void> {
  for await (const _event of conversation.sendMessage(text)) {
    // Only the side effect (a real session turn, a real sessionId) matters here.
  }
}

describe("ConversationRegistry — eviction releases, never deletes (T2.4)", () => {
  test("evicting a live conversation drops the handle but does not touch its SDK transcript", async () => {
    await withApi(async ({ deps, sessions }) => {
      const volume = toVolumeSlug("registry-evict-volume");
      await seedVolume(deps, volume);

      // A registry of the test's own, sized to force eviction on the second
      // insert — independent of `deps.conversations` (maxSize 50 by
      // default), which this test has no reason to touch.
      const registry = new ConversationRegistry({ maxSize: 1 });

      const first = deps.shadowAgent.startConversation(volume);
      await drain(first, "First conversation's first turn.");
      registry.set(first.id, first);

      expect(sessions.sessions).toHaveLength(1);
      const firstSdkSessionId = sessions.sessions[0]?.sessionId;
      expect(firstSdkSessionId).toBeDefined();
      expect(first.sessionId).toBe(firstSdkSessionId);

      const second = deps.shadowAgent.startConversation(volume);
      await drain(second, "Second conversation's first turn.");
      // Inserting past maxSize (1) evicts `first` — the least (and only)
      // recently-used entry.
      registry.set(second.id, second);

      expect(registry.size).toBe(1);
      expect(registry.get(first.id)).toBeUndefined();

      // `release()` dropped the handle...
      expect(first.sessionId).toBeUndefined();
      // ...but the regression this guards is the old `dispose()` behavior:
      // it called `AgenticSession.close()`, which would have deleted the
      // transcript — `sessions.sessions[0]` (the fake session `first` was
      // built on) would show `isClosed: true` and a non-empty
      // `deletedSessionIds`. This must fail on that old behavior and pass
      // on the new one.
      expect(sessions.sessions[0]?.isClosed).toBe(false);
      expect(sessions.sessions[0]?.deletedSessionIds).toEqual([]);
      expect(sessions.sessions[0]?.sessionId).toBe(firstSdkSessionId);
      // And the id-based port deletion (T2.4's other half) was never
      // reached either — eviction has no business calling it at all.
      expect(sessions.deletedStoredSessionIds).toEqual([]);
    });
  });
});

describe("ConversationRegistry — busy-skip seam (T2.4 mechanism)", () => {
  test("a busy session is skipped in favor of the next-oldest evictable one, evicting as many as needed to get back to the cap", async () => {
    await withApi(async ({ deps }) => {
      const volume = toVolumeSlug("registry-busy-skip-volume");

      const busy = new Set<string>();
      const registry = new ConversationRegistry({
        maxSize: 2,
        isSessionBusy: (id) => busy.has(id),
      });

      const a = deps.shadowAgent.startConversation(volume); // oldest, kept busy throughout
      const b = deps.shadowAgent.startConversation(volume);
      const c = deps.shadowAgent.startConversation(volume);
      const d = deps.shadowAgent.startConversation(volume); // newest

      registry.set(a.id, a); // size 1 <= 2 — no eviction
      busy.add(a.id); // a starts a turn before anything else arrives

      registry.set(b.id, b); // size 2 <= 2 — no eviction
      registry.set(c.id, c); // size 3 > 2: a is oldest but busy — skipped.
      // Next-oldest evictable is b: evicted. Back to 2 <= 2 — stop.
      expect(registry.size).toBe(2);

      registry.set(d.id, d); // size 3 > 2 again: a busy, skipped; next-oldest
      // evictable is now c (b is already gone) — evicted. Back to 2 <= 2.
      // (Deliberately no `.get()` calls between these two `.set()`s — `get`
      // touches an entry's LRU position, which would muddy what "next-
      // oldest" means for this second eviction pass. All presence checks
      // happen at the end instead, once eviction is done.)

      expect(registry.size).toBe(2);
      expect(registry.get(a.id)).toBe(a); // busy the entire time — never evicted
      expect(registry.get(b.id)).toBeUndefined();
      expect(registry.get(c.id)).toBeUndefined();
      expect(registry.get(d.id)).toBe(d);
    });
  });

  test("busy sessions survive eviction pressure past the cap (size <= maxSize + busy-count) and are evicted once the predicate flips on re-run", async () => {
    await withApi(async ({ deps }) => {
      const volume = toVolumeSlug("registry-busy-overshoot-volume");

      const busy = new Set<string>();
      const registry = new ConversationRegistry({
        maxSize: 1,
        isSessionBusy: (id) => busy.has(id),
      });

      const a = deps.shadowAgent.startConversation(volume);
      const b = deps.shadowAgent.startConversation(volume);

      busy.add(a.id);
      registry.set(a.id, a); // size 1 <= 1 — no eviction attempted yet
      busy.add(b.id);
      registry.set(b.id, b); // size 2 > 1, but both entries are busy — nothing
      // evictable exists this pass, so eviction leaves both in place: the
      // documented `size <= maxSize + busy-count` overshoot (2 <= 1 + 2),
      // not a bug, and the loop still terminates rather than spinning.

      // Both remain — size 2 with only 2 ever inserted means both survived,
      // no `.get()` touch needed to prove it (and `.get()` would move
      // whichever id it names to the LRU-fresh end, muddying the ordering
      // the next step relies on).
      expect(registry.size).toBe(2);

      // `a`'s turn settles — T2.5's `SessionService` re-runs eviction right
      // here, exactly like this test does, rather than waiting for some
      // unrelated `set()` to happen to retrigger it.
      busy.delete(a.id);
      registry.evict();

      expect(registry.size).toBe(1);
      expect(registry.get(a.id)).toBeUndefined(); // released now that it's safe
      expect(registry.get(b.id)).toBe(b); // still busy, still held
    });
  });

  test("evict() terminates in a single pass even when nothing is evictable", async () => {
    await withApi(async ({ deps }) => {
      const volume = toVolumeSlug("registry-busy-terminate-volume");
      const registry = new ConversationRegistry({ maxSize: 0, isSessionBusy: () => true });

      const a = deps.shadowAgent.startConversation(volume);
      registry.set(a.id, a);

      // maxSize 0 with an always-busy predicate: every insert is "over
      // cap", nothing is ever evictable. `set()` calling `evict()`
      // synchronously without hanging/looping forever is the assertion.
      expect(registry.size).toBe(1);
      expect(registry.get(a.id)).toBe(a);
    });
  });
});

describe("ConversationRegistry — releaseAll (shutdown)", () => {
  test("releases every held conversation without deleting transcripts, and empties the registry", async () => {
    await withApi(async ({ deps, sessions }) => {
      const volume = toVolumeSlug("registry-shutdown-volume");
      await seedVolume(deps, volume);

      const registry = new ConversationRegistry();
      const conversation = deps.shadowAgent.startConversation(volume);
      await drain(conversation, "Only turn before shutdown.");
      registry.set(conversation.id, conversation);

      await registry.releaseAll();

      expect(registry.size).toBe(0);
      expect(conversation.sessionId).toBeUndefined();
      expect(sessions.sessions[0]?.isClosed).toBe(false);
      expect(sessions.sessions[0]?.deletedSessionIds).toEqual([]);
    });
  });
});
