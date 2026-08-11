/**
 * `RetrievalStrategy` — the port T4.2's comparison is built on.
 *
 * "SOLID: a strategy is an interface; adding one must not modify the
 * harness" (this package's own brief) — mirrors exactly why
 * `@shadow/indexing` made `Indexer`/`Navigator` ports (`ARCHITECTURE.md`).
 * `harness/harness.ts` depends only on this interface; every strategy in
 * `strategies/*` is a plain implementation of it, and a fourth strategy
 * could be added without the harness changing at all.
 */

import type { ChapterId } from "../corpus/chapter-id.ts";
import type { TokenCost } from "./token-tracking.ts";

export type StrategyVerdict = "found" | "not-in-corpus";

export interface StrategyQueryResult {
  /** Rank order, best-first, deduplicated to chapter granularity — see `corpus/chapter-id.ts`. */
  readonly retrieved: readonly ChapterId[];
  readonly verdict: StrategyVerdict;
  readonly tokenCost: TokenCost;
  /** Navigator-backed strategies only — how many navigate/grade rounds this query took. `undefined` for a strategy with no round concept (naive BM25). */
  readonly rounds?: number;
}

export interface RetrievalStrategy {
  readonly name: string;
  readonly description: string;
  retrieve(query: string): Promise<StrategyQueryResult>;
}

/** Dedupe a `ChapterId` list while preserving first-seen (rank) order — shared by every strategy that resolves node-level citations down to chapter granularity. */
export function dedupeChapterIds(ids: readonly ChapterId[]): readonly ChapterId[] {
  const seen = new Set<ChapterId>();
  const out: ChapterId[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
