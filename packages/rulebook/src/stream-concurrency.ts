/**
 * Small bounded worker pool that streams results as they finish rather than
 * only once every item is done — the streaming counterpart to a
 * `Promise.all`-shaped batch primitive callers with progress events (or
 * simply a bound on in-flight LLM calls) need. Completion order, not input
 * order.
 *
 * Settle-all-then-throw-first: a worker whose item throws is caught here,
 * not left to reject the worker's promise silently — `remaining` still
 * decrements and the drain loop still wakes, so the loop always
 * terminates; only after every in-flight/queued item has settled does the
 * generator rethrow the first recorded error.
 *
 * Shared by `rulebook-tool-agent.ts` (chunk extraction fan-out, group
 * assemble+publish fan-out) and `finalize-groups.ts` (batched group
 * finalization calls) — extracted out of the tool agent once a second call
 * site needed it.
 */
export async function* streamWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): AsyncGenerator<R> {
  if (items.length === 0) return;

  const ready: R[] = [];
  let wake: (() => void) | undefined;
  let nextIndex = 0;
  let remaining = items.length;
  let failed = false;
  let firstError: unknown;

  function notify(): void {
    if (wake) {
      const resolveWake = wake;
      wake = undefined;
      resolveWake();
    }
  }

  async function runWorker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        const result = await worker(items[index] as T);
        ready.push(result);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      } finally {
        remaining -= 1;
        notify();
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, () => runWorker());

  while (remaining > 0 || ready.length > 0) {
    if (ready.length > 0) {
      yield ready.shift() as R;
      continue;
    }
    await new Promise<void>((resolvePromise) => {
      wake = resolvePromise;
    });
  }

  await Promise.all(workers);
  if (failed) throw firstError;
}
