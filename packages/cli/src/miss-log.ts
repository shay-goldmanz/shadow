/**
 * The miss log (D14): "every `not-in-corpus` verdict appended to
 * `misses.jsonl`" — the operator's authoring backlog.
 *
 * **T2.7 reconciliation.** T3.1 (this package) and T2.6 (`@shadow/indexing`)
 * each built a miss log independently: this file used to be a full
 * NDJSON-on-disk implementation (manual `appendFile`/`JSON.parse`), and
 * `@shadow/indexing`'s `lint-miss-log.ts` built the same thing again behind
 * a `MissLogStore` port (`FileMissLog`/`InMemoryMissLog`), deliberately
 * leaving the on-disk path to this package to decide. Two implementations
 * of one concept, pinned together by nothing — exactly the shape of bug
 * `nfc-ws-v1` warned about. `FileMissLog` is now the single implementation;
 * this module no longer touches the filesystem itself. It only:
 *
 * - resolves *where* the shared log lives (`<root>/misses.jsonl`, a sibling
 *   of `<root>/index.json` — `context.ts` owns `root` for the same reason),
 * - builds a `FileMissLog` pointed at that path, and
 * - widens `@shadow/indexing`'s fixed `MissLogEntry` contract (`task`,
 *   `sourceChapterId?`, `recordedAt`) to the union this package's own
 *   writer (`shadow find`'s `not-in-corpus` verdict) actually needs.
 *
 * **Why the union, not the intersection.** `MissLogEntry` has no slot for
 * *why* a query missed (`reason`) or *which round* it missed on (`round`) —
 * both genuinely useful to an operator deciding what to write next (an
 * `empty-corpus` miss means "write anything"; a `rounds-exhausted` miss on
 * a large corpus means "the router almost found it, sharpen a `when_to_use`").
 * Dropping them to fit the narrow interface would defeat the point of the
 * log. `MissLogStore.append` takes a `MissLogEntry`, but TypeScript's
 * structural typing only checks required fields are present — a caller may
 * pass a value with *extra* own properties through a typed variable (excess
 * property checks apply only to fresh object literals assigned directly),
 * and `FileMissLog.append` serializes with `JSON.stringify`, which persists
 * whatever's actually on the object at runtime, not just what the static
 * type names. So `reason`/`round`/`source` ride along as extra JSON fields
 * without forking `FileMissLog` or narrowing what `shadow find` can record.
 */

import { join } from "node:path";
import { FileMissLog, type MissLogEntry, type MissLogStore } from "@shadow/indexing";

export type MissReason = "no-match" | "empty-corpus" | "rounds-exhausted";

/**
 * The union this package's reader (`shadow misses`) renders — `MissLogEntry`'s
 * fixed fields (`task`, `sourceChapterId?`, `recordedAt`) plus `reason`/`round`,
 * present only on entries `shadow find` wrote (`@shadow/indexing`'s
 * `checkSelfRetrieval` — `shadow lint`'s writer — knows nothing about
 * either field, so its entries simply lack them). `source` is a CLI-side
 * label recorded only on `shadow find`'s own writes; `isFindMiss` is the
 * reliable check for any entry, including ones written before `source`
 * existed or by a future writer that never adopts it.
 */
export interface ShadowMissEntry extends MissLogEntry {
  readonly source?: "find" | "lint";
  readonly reason?: MissReason;
  readonly round?: number;
}

/** `shadow find`'s writer — `ShadowMissEntry` narrowed to the fields it always sets. */
export interface FindMissEntry extends ShadowMissEntry {
  readonly source: "find";
  readonly reason: MissReason;
}

/** `true` if `entry` carries the `reason` field only `shadow find` ever writes — the reliable signal, since `source` is best-effort metadata rather than the contract. */
export function isFindMiss(entry: ShadowMissEntry): entry is FindMissEntry {
  return entry.reason !== undefined;
}

/** Where the one shared miss log lives on disk: a sibling of `<root>/index.json`. */
export function missLogPath(root: string): string {
  return join(root, "misses.jsonl");
}

/** Build the `MissLogStore` every CLI command reads/writes the shared backlog through. */
export function createMissLog(root: string): MissLogStore {
  return new FileMissLog(missLogPath(root));
}

/** Build a `shadow find` miss entry, stamped with the current time unless `now` is overridden (deterministic tests). */
export function toFindMissEntry(params: {
  readonly query: string;
  readonly reason: MissReason;
  readonly round?: number;
  readonly now?: () => Date;
}): FindMissEntry {
  const now = params.now ?? (() => new Date());
  return {
    task: params.query,
    source: "find",
    reason: params.reason,
    round: params.round,
    recordedAt: now().toISOString(),
  };
}

/**
 * Widen whatever `MissLogStore.readAll()` returns (typed narrowly as
 * `MissLogEntry`, the fixed contract) to the richer union this package's
 * own writer actually persists. No cast needed — every extra field on
 * `ShadowMissEntry` is optional, so `MissLogEntry` is already structurally
 * assignable to it; this function exists purely to name the intent at the
 * call site (`shadow misses` reading the shared log back).
 */
export function widenMisses(entries: readonly MissLogEntry[]): readonly ShadowMissEntry[] {
  return entries;
}
