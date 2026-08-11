/**
 * Test-only helpers, not part of the public surface (not re-exported from
 * `index.ts`). Mirrors `@shadow/core`'s `test-helpers.ts`.
 *
 * `expect(promise).rejects.toBeInstanceOf(...)` is Bun's documented API,
 * but its matcher methods are typed to return `void` even though the
 * chain must be awaited to actually run — that mismatch trips oxlint's
 * type-aware `await-thenable` rule (D8). `expect.unreachable` (also
 * documented by bun:test) sidesteps it entirely with a plain try/catch.
 */

import { expect } from "bun:test";

// biome-ignore lint/suspicious/noExplicitAny: constructor signatures are inherently heterogeneous
type ErrorConstructor<E> = new (...args: any[]) => E;

/** Await `promise`, assert it rejects, and assert the rejection is an instance of `ctor`. Returns the rejection. */
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
