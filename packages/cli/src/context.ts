/**
 * Where `shadow` lives on disk, and the store it talks through.
 *
 * `@shadow/core`'s `FileSystemVolumeStore` defaults to `~/.shadow` (D4) and
 * keeps that root private — nothing outside `@shadow/core` builds a path
 * *into* the store. This module owns exactly one sibling fact the store
 * does not expose: the root directory itself, which the CLI needs for two
 * things the store has no slot for — resolving a test-isolated root via
 * `SHADOW_HOME`, and the miss log (`miss-log.ts`, wired to `@shadow/indexing`'s
 * `FileMissLog` since T2.7), which D14 places alongside the corpus index
 * rather than inside any single volume.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { FileSystemVolumeStore, type VolumeStore } from "@shadow/core";

/** Environment lookup, narrowed to what this module reads — real `process.env` satisfies it, and tests can pass a plain object. */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * The storage root `shadow` operates against: `SHADOW_HOME` when set to a
 * non-empty string (test isolation, or an operator running multiple
 * corpora), otherwise `~/.shadow` — the same default `FileSystemVolumeStore`
 * uses on its own.
 */
export function resolveShadowRoot(env: EnvLike = process.env): string {
  const override = env.SHADOW_HOME;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".shadow");
}

export interface CliContext {
  readonly root: string;
  readonly store: VolumeStore;
}

/**
 * Build the context every command runs against. `rootOverride` (from a
 * future `--root` flag, or a test harness) takes precedence over
 * `SHADOW_HOME`; both are checked before falling back to the default root.
 */
export function createContext(env: EnvLike = process.env, rootOverride?: string): CliContext {
  const root = rootOverride ?? resolveShadowRoot(env);
  return { root, store: new FileSystemVolumeStore(root) };
}
