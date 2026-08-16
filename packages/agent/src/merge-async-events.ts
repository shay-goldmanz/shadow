/**
 * `mergeAsyncEvents` — merge N concurrently-running producers into a single
 * async stream, ordered by when each event actually arrives (settle order),
 * not by producer position. Built for T0.2 (`conversation.ts`'s parallel
 * research briefs), deliberately as its own module with its own tests: this
 * is the hardest code in Tier 0 — a hand-rolled push/drain queue has to get
 * completion, buffering, and error propagation right with nothing to lean
 * on but plain `Promise`s.
 *
 * ## Shape
 *
 * A producer is `(push: (event: T) => void) => Promise<void>`: it may call
 * `push` any number of times (T0.2's callers call it exactly once, but nothing
 * here assumes that) and its returned promise settles when the producer is
 * done. `mergeAsyncEvents` runs every producer immediately and concurrently
 * (kicked off in one synchronous pass over the array, before the merged
 * generator ever yields), and yields each pushed event to the consumer in
 * the order it was pushed *across* producers — i.e. whichever producer is
 * fastest at a given moment wins, regardless of array position.
 *
 * ## Completion and errors
 *
 * The merge finishes once every producer's promise has settled and every
 * buffered event has been drained. A producer whose promise *rejects* is not
 * swallowed: the merge surfaces that rejection by throwing it out of the
 * generator once there is nothing already-pushed left to drain first — so an
 * error is never silently dropped, but it also never erases events that
 * genuinely arrived before it. This is a different failure channel than
 * "the underlying operation failed" (T0.2's callers catch that themselves
 * and push a failure-shaped event instead) — it exists for bugs in a
 * producer itself, which should propagate, not vanish.
 *
 * ## Buffering
 *
 * Events are buffered only between the moment a producer calls `push` and
 * the moment the consumer next asks for a value — ordinary backpressure-free
 * queuing, not accumulation with no drain in sight. With one push per
 * producer (T0.2's usage) the buffer is bounded by producer count; a
 * producer that pushes many events is still bounded by how far ahead of the
 * consumer it can get before the consumer resumes pulling.
 */

export type AsyncEventProducer<T> = (push: (event: T) => void) => Promise<void>;

export async function* mergeAsyncEvents<T>(
  producers: readonly AsyncEventProducer<T>[],
): AsyncGenerator<T, void, undefined> {
  if (producers.length === 0) return;

  const buffered: T[] = [];
  let waiter: (() => void) | undefined;
  let remaining = producers.length;
  let failure: { readonly error: unknown } | undefined;

  const wake = (): void => {
    const resolve = waiter;
    waiter = undefined;
    resolve?.();
  };

  const push = (event: T): void => {
    buffered.push(event);
    wake();
  };

  // Kick off every producer in one synchronous pass so they genuinely run
  // concurrently — none of this waits on an `await` before the next
  // producer starts. Each producer's own rejection is caught right here
  // (never an unhandled rejection, however long the others take, and
  // regardless of whether the consumer keeps draining) and recorded as the
  // merge's failure, first one wins; later ones are dropped deliberately,
  // mirroring `Promise.all`. This `.catch`/`.finally` pair is what makes it
  // safe for the loop below to surface a failure without waiting for every
  // producer to settle first — a still-running producer can never leak an
  // unhandled rejection into the process, so there is nothing to block on.
  for (const producer of producers) {
    producer(push)
      .catch((error: unknown) => {
        if (!failure) failure = { error };
      })
      .finally(() => {
        remaining -= 1;
        wake();
      });
  }

  while (true) {
    if (buffered.length > 0) {
      // biome-ignore lint/style/noNonNullAssertion: length just checked
      yield buffered.shift()!;
      continue;
    }
    if (failure) throw failure.error;
    if (remaining === 0) return;
    await new Promise<void>((resolve) => {
      waiter = resolve;
    });
  }
}
