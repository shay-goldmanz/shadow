/**
 * `VolumeLocks` — a per-key async mutex, keyed by volume slug (T0.6).
 *
 * Chapter publication (`publish.ts`) does read-modify-write on shared
 * per-volume files (the claim sidecar, retirement-event appends —
 * `@shadow/evidence`'s `store.ts` `putClaims`) and reindexes the corpus.
 * `conversation.ts`'s auto-continuation loop already runs chapter directives
 * one at a time *within* a single conversation, but nothing previously
 * stopped two different conversations — two operator sessions on the same
 * volume — from running `draftChapter`/`publishChapter` concurrently and
 * racing that shared state. `ShadowAgent` owns one `VolumeLocks` instance,
 * shared by every `ShadowConversation` it mints, so "same volume" is
 * serialized regardless of which conversation is publishing — while
 * different volumes stay fully independent (no cross-volume contention, no
 * global lock).
 *
 * ## Shape
 *
 * `withLock(key, fn)` chains `fn` calls for the same `key` into a strict
 * queue via a promise per key, tail-appended on each call and awaited before
 * the next `fn` starts — no polling, no timers. `fn` is called at most once
 * concurrently per key; different keys never wait on each other. The lock is
 * released whether `fn` resolves or throws (a `try`/`finally` around the
 * call), so one caller's failure can never wedge every later caller on that
 * key. Once a key's queue fully drains (every queued `withLock` call for it
 * has returned or thrown), its entry is removed from the internal map — a
 * long-running process publishing to many volumes over time does not grow
 * this map without bound.
 */

export class VolumeLocks {
  private readonly chains = new Map<string, Promise<void>>();

  /**
   * Run `fn` with the mutex for `key` held. If another call is already
   * queued or running for the same `key`, this call waits for every earlier
   * one to finish (in call order) before `fn` starts. Returns (or throws)
   * whatever `fn` does; the lock is released in either case before
   * `withLock` settles.
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The new tail: resolves only once *this* call's turn has come (previous
    // holder released) *and* this call has itself released. The next
    // `withLock` on the same key awaits exactly this — that's the whole
    // queue, one promise at a time.
    const tail = previous.then(() => held);
    this.chains.set(key, tail);

    await previous; // wait for our turn
    try {
      return await fn();
    } finally {
      release();
      // Only the most-recently-queued call for this key removes the entry —
      // if someone queued behind us while we held the lock, `chains.get(key)`
      // has already moved on to their tail by the time we get here, and
      // deleting would drop their place in line.
      if (this.chains.get(key) === tail) {
        this.chains.delete(key);
      }
    }
  }

  /** Number of keys with a live (running or queued) chain. Test/introspection only. */
  get lockedKeyCount(): number {
    return this.chains.size;
  }
}
