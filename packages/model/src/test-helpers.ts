/**
 * Test-only helpers, not part of the public surface (not re-exported from
 * `index.ts`). Mirrors the pattern in `@shadow/core/test-helpers.ts`.
 */

import { expect } from "bun:test";

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

/** Call `fn`, assert it throws synchronously, and assert the thrown value is an instance of `ctor`. Returns it. */
export function expectSyncThrow<E>(fn: () => void, ctor: ErrorConstructor<E>): E {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ctor);
    return error as E;
  }
  return expect.unreachable(`expected function to throw ${ctor.name}, but it returned`);
}
