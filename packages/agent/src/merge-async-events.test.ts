/**
 * `mergeAsyncEvents` on its own, with nothing from `conversation.ts` in the
 * loop — the plan calls this the hardest code in Tier 0 and asks for it to
 * get its own focused treatment (T0.2). Every producer here is a hand-built
 * deferred promise so each test can dictate settle order precisely, the
 * thing production code can never fully control but tests must.
 */

import { describe, expect, test } from "bun:test";
import { type AsyncEventProducer, mergeAsyncEvents } from "./merge-async-events.ts";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A producer that pushes exactly one event once `gate` settles — mirrors T0.2's one-event-per-brief usage. */
function singlePushProducer<T>(gate: Promise<T>): AsyncEventProducer<T> {
  return async (push) => {
    const value = await gate;
    push(value);
  };
}

/** Drains a generator to completion, collecting every yielded value in order. */
async function collect<T>(gen: AsyncGenerator<T, void, undefined>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of gen) out.push(value);
  return out;
}

describe("mergeAsyncEvents — empty input", () => {
  test("no producers -> completes immediately with no events", async () => {
    const events = await collect(mergeAsyncEvents<string>([]));
    expect(events).toEqual([]);
  });
});

describe("mergeAsyncEvents — multiple producers", () => {
  test("every producer's event is yielded exactly once", async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const c = deferred<string>();

    const gen = mergeAsyncEvents([
      singlePushProducer(a.promise),
      singlePushProducer(b.promise),
      singlePushProducer(c.promise),
    ]);
    const done = collect(gen);

    a.resolve("a");
    b.resolve("b");
    c.resolve("c");

    expect((await done).toSorted()).toEqual(["a", "b", "c"]);
  });
});

describe("mergeAsyncEvents — settle-order draining", () => {
  test("a later producer that settles first is yielded first", async () => {
    const first = deferred<string>();
    const second = deferred<string>();

    // Array order is [first-index producer, second-index producer], but
    // `second` is the one that actually settles first.
    const gen = mergeAsyncEvents([
      singlePushProducer(first.promise),
      singlePushProducer(second.promise),
    ]);
    const done = collect(gen);

    second.resolve("second-settled-first");
    // Give the merge a turn to drain what's already buffered before the
    // slower producer resolves, so this genuinely exercises settle order
    // rather than coincidentally reading in array order.
    await Promise.resolve();
    await Promise.resolve();
    first.resolve("first-settled-last");

    expect(await done).toEqual(["second-settled-first", "first-settled-last"]);
  });

  test("a producer that pushes multiple events yields each as it is pushed, interleaved with others", async () => {
    const pushes: ((event: string) => void)[] = [];
    const finishers: (() => void)[] = [];

    const multi: AsyncEventProducer<string> = (push) => {
      pushes.push(push);
      return new Promise<void>((resolve) => finishers.push(resolve));
    };
    const single = deferred<string>();

    const gen = mergeAsyncEvents([multi, singlePushProducer(single.promise)]);
    const iterator = gen[Symbol.asyncIterator]();

    // Prime the producers (start() runs synchronously up to their first await).
    const firstNext = iterator.next();
    // biome-ignore lint/style/noNonNullAssertion: multi producer registered synchronously above
    pushes[0]!("multi-1");
    expect((await firstNext).value).toBe("multi-1");

    const secondNext = iterator.next();
    single.resolve("single-1");
    expect((await secondNext).value).toBe("single-1");

    const thirdNext = iterator.next();
    // biome-ignore lint/style/noNonNullAssertion: multi producer registered synchronously above
    pushes[0]!("multi-2");
    expect((await thirdNext).value).toBe("multi-2");

    // biome-ignore lint/style/noNonNullAssertion: multi producer's own promise resolver, registered synchronously above
    finishers[0]!();
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });
});

describe("mergeAsyncEvents — completion", () => {
  test("finishes only after every producer has settled, not after the first", async () => {
    const fast = deferred<string>();
    const slow = deferred<string>();

    const gen = mergeAsyncEvents([
      singlePushProducer(fast.promise),
      singlePushProducer(slow.promise),
    ]);
    const iterator = gen[Symbol.asyncIterator]();

    fast.resolve("fast");
    expect((await iterator.next()).value).toBe("fast");

    // Nothing left buffered and the slow producer hasn't settled yet —
    // `next()` must not resolve as "done" prematurely. Track whether the
    // single in-flight call has settled without racing it against a second
    // `next()` call (which would just queue behind it per the async
    // generator spec, not prove anything about the first call).
    let settled = false;
    const pending = iterator.next().then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    slow.resolve("slow");
    expect((await pending).value).toBe("slow");
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });
});

describe("mergeAsyncEvents — error propagation", () => {
  test("a rejecting producer's error surfaces from the generator, after already-buffered events drain", async () => {
    const ok = deferred<string>();
    const failing = deferred<string>();

    const gen = mergeAsyncEvents([
      singlePushProducer(ok.promise),
      async () => {
        await failing.promise;
        throw new Error("producer blew up");
      },
    ]);
    const iterator = gen[Symbol.asyncIterator]();

    ok.resolve("already-arrived");
    expect((await iterator.next()).value).toBe("already-arrived");

    failing.reject(new Error("producer blew up"));
    // `expect(promise).rejects...` is documented Bun API, but its matchers
    // are typed `void` despite needing an await, which trips oxlint's
    // type-aware `await-thenable` rule — plain `.catch` sidesteps it
    // (matching `@shadow/web`'s `contract.test.ts`/`@shadow/cli`'s
    // `loaders.test.ts` convention).
    const error = await iterator.next().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("producer blew up");
  });

  test("does not hang or leak an unhandled rejection when a slower producer settles after the failure", async () => {
    const failFast = deferred<string>();
    const slowOk = deferred<string>();

    const gen = mergeAsyncEvents([
      async () => {
        await failFast.promise;
        throw new Error("fails first");
      },
      singlePushProducer(slowOk.promise),
    ]);
    const done = collect(gen).catch((error: unknown) => error);

    failFast.reject(new Error("fails first"));
    const outcome = await done;
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("fails first");

    // Resolve the still-outstanding producer after the merge has already
    // thrown — its `.catch` inside `mergeAsyncEvents` must have already
    // absorbed this, or Bun would report an unhandled rejection for the
    // test run.
    slowOk.resolve("late");
  });

  test("only the first rejection is surfaced when multiple producers fail", async () => {
    const gen = mergeAsyncEvents([
      async () => {
        throw new Error("first failure");
      },
      async () => {
        await Promise.resolve();
        throw new Error("second failure");
      },
    ]);

    const error = await collect(gen).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("first failure");
  });
});
