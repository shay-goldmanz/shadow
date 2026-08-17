/**
 * `SessionLock` — a per-key async mutex with a bounded admission queue,
 * genericized from `@shadow/agent`'s `VolumeLocks` pattern
 * (`packages/agent/src/volume-locks.ts`) rather than a new mutex primitive.
 * `SessionService` (T2.5) is the one caller: every session id is a key, and
 * a "job" is a turn — including the rehydration work the first job for a
 * cold session id does before it ever calls `AgenticSession.stream()` (see
 * `session-service.ts`'s `ensureConversation`). Two structural differences
 * from `VolumeLocks` earn this its own class instead of reusing that one
 * directly:
 *
 * - **Admission is bounded and synchronous.** `VolumeLocks.withLock` always
 *   queues; nothing there can express "reject this job instead of queuing
 *   it," and nothing tracks *how many* jobs are already waiting for a key at
 *   all. The plan's queue bound (4 pending turns per session, PLAN.md's
 *   Tier 2 concurrency model) needs both: `tryReserve` is a synchronous
 *   check-and-increment against a per-key waiting count, so two callers
 *   racing to enqueue the same session's 5th turn can't both slip past the
 *   bound — there is no `await` between the count check and the reservation,
 *   and JS's single-threaded execution means nothing else can run *between*
 *   two synchronous statements in the same call.
 * - **Busy-ness needs to be queryable from outside, without polling.**
 *   `ConversationRegistry`'s eviction (T2.4) needs a live `isSessionBusy`
 *   predicate (`conversation-registry.ts`'s module doc) — `hasActivity`
 *   answers that in O(1) from the same map `runReserved` already maintains,
 *   with no separate bookkeeping.
 *
 * ## Two-step API, not one `withLock`
 *
 * `tryReserve` (synchronous) and `runReserved` (async) are deliberately
 * separate calls, not one bound-checking `withLock`: `SessionService` needs
 * to subscribe a turn's viewer to the session's event bus *between* the two
 * — reserving a queue slot before touching the bus (so a rejected turn never
 * subscribes at all), then actually running the turn only once the
 * subscription exists (so the very first record the turn appends, at run
 * start, can never be missed by its own enqueuer — see `session-bus.ts`'s
 * module doc). Collapsing both into one call would force that subscription
 * to happen either before the bound check (leaking a subscription on
 * rejection) or inside the queued callback itself (too late — the callback
 * doesn't run until this job's turn in the FIFO comes up, by which point an
 * earlier job in the same queue may already have started publishing).
 */

export class SessionLock {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly waitingCounts = new Map<string, number>();

  /**
   * Synchronous check-and-reserve: if fewer than `max` jobs are currently
   * queued (reserved but not yet running) for `key`, reserves a slot and
   * returns `true`; otherwise reserves nothing and returns `false`. The
   * currently-*running* job for `key`, if any, does not count against
   * `max` — only jobs still waiting for their turn do (a session with one
   * turn in flight and `max` more queued behind it is exactly at capacity,
   * matching PLAN.md's "queue bound: 4 pending").
   *
   * Every successful `tryReserve` must be followed by exactly one
   * `runReserved` call for the same `key` — that call is what releases the
   * reservation once the job actually starts running.
   */
  tryReserve(key: string, max: number): boolean {
    const current = this.waitingCounts.get(key) ?? 0;
    if (current >= max) return false;
    this.waitingCounts.set(key, current + 1);
    return true;
  }

  /**
   * Runs `fn` once every earlier `runReserved` call for the same `key` has
   * finished (FIFO — the exact chaining shape `VolumeLocks.withLock` uses),
   * releasing this call's queue reservation the moment its turn actually
   * comes up (not when it finishes) — from that point on, this job counts as
   * *running*, not *queued*, for `tryReserve`'s bound. The lock itself
   * (`chains`) is released whether `fn` resolves or throws, so one job's
   * failure can never wedge a later one queued behind it on the same key.
   *
   * Caller contract: only call this after a successful `tryReserve(key, …)`
   * — this method does not itself check or enforce the bound, it only
   * consumes the reservation that call made.
   */
  async runReserved<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => held);
    this.chains.set(key, tail);

    await previous; // wait for our turn
    const waiting = this.waitingCounts.get(key) ?? 1;
    if (waiting <= 1) {
      this.waitingCounts.delete(key);
    } else {
      this.waitingCounts.set(key, waiting - 1);
    }

    try {
      return await fn();
    } finally {
      release();
      if (this.chains.get(key) === tail) {
        this.chains.delete(key);
      }
    }
  }

  /**
   * Whether `key` has any job queued or running right now — `false` exactly
   * when every `runReserved` call for `key` has fully settled. The seam
   * `SessionService` wires into `ConversationRegistry`'s `isSessionBusy`
   * (T2.4/T2.5): a session with a turn in flight (or queued behind one) must
   * never be evicted out from under it.
   */
  hasActivity(key: string): boolean {
    return this.chains.has(key);
  }
}
