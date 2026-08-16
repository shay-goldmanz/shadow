/**
 * `VolumeLocks` on its own, with nothing from `conversation.ts` in the loop
 * (mirrors `merge-async-events.test.ts`'s pattern for T0.2's utility). Every
 * scenario here is driven by hand-built deferred promises so a test can
 * dictate exactly when a holder's `fn` finishes, which is the only way to
 * prove mutual exclusion rather than merely hope timing works out.
 */

import { describe, expect, test } from "bun:test";
import { VolumeLocks } from "./volume-locks.ts";

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

describe("VolumeLocks — mutual exclusion on one key", () => {
  test("a second holder's fn does not start until the first releases", async () => {
    const locks = new VolumeLocks();
    const events: string[] = [];
    const gate = deferred<void>();

    const first = locks.withLock("vol-a", async () => {
      events.push("first:start");
      await gate.promise;
      events.push("first:end");
    });

    // Let `first` actually begin running before queuing the second call.
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    const second = locks.withLock("vol-a", async () => {
      events.push("second:start");
      events.push("second:end");
    });

    // Several microtask turns pass with `first` still holding the gate —
    // `second` must not have started.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    gate.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  test("N holders on one key are strictly serialized: never more than one fn active, call order preserved", async () => {
    const locks = new VolumeLocks();
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];

    async function hold(id: number, delayMs: number): Promise<void> {
      return locks.withLock("vol-a", async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(id);
        await Bun.sleep(delayMs);
        active -= 1;
      });
    }

    // Call order is 1, 2, 3; deliberately give the *earlier* calls the
    // *longer* delays so "serialized" can't be mistaken for "just happened
    // to finish in call order because nothing overlapped anyway."
    await Promise.all([hold(1, 15), hold(2, 5), hold(3, 1)]);

    expect(maxActive).toBe(1);
    expect(order).toEqual([1, 2, 3]);
  });
});

describe("VolumeLocks — release on error", () => {
  test("a throwing holder still releases the lock, and its rejection propagates to its own caller", async () => {
    const locks = new VolumeLocks();
    const failure = new Error("boom");

    // `expect(promise).rejects...` is documented Bun API, but its matchers
    // are typed `void` despite needing an await, which trips oxlint's
    // type-aware `await-thenable` rule — plain `.catch` sidesteps it
    // (matching `@shadow/agent`'s `merge-async-events.test.ts` convention).
    const caught = await locks
      .withLock("vol-a", async () => {
        throw failure;
      })
      .catch((e: unknown) => e);
    expect(caught).toBe(failure);

    // The next caller on the same key is not wedged behind the failure.
    let ran = false;
    await locks.withLock("vol-a", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("a holder queued behind a failing one still runs, unaffected by the failure", async () => {
    const locks = new VolumeLocks();
    const gate = deferred<void>();
    const events: string[] = [];

    const failing = locks
      .withLock("vol-a", async () => {
        events.push("failing:start");
        await gate.promise;
        throw new Error("boom");
      })
      .catch(() => {
        events.push("failing:caught");
      });

    await Promise.resolve();
    await Promise.resolve();

    const queued = locks.withLock("vol-a", async () => {
      events.push("queued:start");
    });

    gate.resolve();
    await Promise.all([failing, queued]);

    expect(events).toEqual(["failing:start", "failing:caught", "queued:start"]);
  });
});

describe("VolumeLocks — independent keys", () => {
  test("different keys run concurrently; one key's in-flight holder never blocks another key", async () => {
    const locks = new VolumeLocks();
    const events: string[] = [];
    const gateA = deferred<void>();

    const a = locks.withLock("vol-a", async () => {
      events.push("a:start");
      await gateA.promise;
      events.push("a:end");
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["a:start"]);

    // `vol-b` must be able to run to completion while `vol-a`'s holder is
    // still parked on its gate.
    const b = locks.withLock("vol-b", async () => {
      events.push("b:start");
      events.push("b:end");
    });
    await b;

    expect(events).toEqual(["a:start", "b:start", "b:end"]);

    gateA.resolve();
    await a;
    expect(events).toEqual(["a:start", "b:start", "b:end", "a:end"]);
  });
});

describe("VolumeLocks — cleanup", () => {
  test("a key's entry is removed once its chain fully drains", async () => {
    const locks = new VolumeLocks();
    expect(locks.lockedKeyCount).toBe(0);

    await locks.withLock("vol-a", async () => {
      expect(locks.lockedKeyCount).toBe(1);
    });
    expect(locks.lockedKeyCount).toBe(0);
  });

  test("cleanup still happens after multiple queued calls on the same key drain in full", async () => {
    const locks = new VolumeLocks();

    await Promise.all([
      locks.withLock("vol-a", async () => {}),
      locks.withLock("vol-a", async () => {}),
      locks.withLock("vol-a", async () => {}),
    ]);

    expect(locks.lockedKeyCount).toBe(0);
  });

  test("a key still in use is not cleaned up early by a sibling key's completion", async () => {
    const locks = new VolumeLocks();
    const gateA = deferred<void>();

    const a = locks.withLock("vol-a", async () => {
      await gateA.promise;
    });
    await locks.withLock("vol-b", async () => {});

    expect(locks.lockedKeyCount).toBe(1); // vol-a still pending, vol-b cleaned up

    gateA.resolve();
    await a;
    expect(locks.lockedKeyCount).toBe(0);
  });
});
