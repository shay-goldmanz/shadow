/**
 * `shadow index [--check]` — rebuild the corpus index (`StructuralIndexer`,
 * `@shadow/indexing`), or, with `--check`, verify the persisted index still
 * matches a fresh build without writing anything, for CI-style staleness
 * gates. Named `reindex.ts` to avoid colliding with this package's own
 * `src/index.ts`; the CLI command name is still `index`.
 *
 * Even `--check` mode calls `Indexer.build`, which mints any missing
 * chapter `id` (D13) as an unavoidable side effect of building at all —
 * documented here rather than worked around, matching
 * `@shadow/indexing`'s own documented posture on the same tradeoff.
 */

import type { VolumeStore } from "@shadow/core";
import {
  type IndexDocument,
  type IndexStats,
  type MintedId,
  StructuralIndexer,
} from "@shadow/indexing";
import { StaleIndexError } from "../errors.ts";

export interface IndexCommandOptions {
  readonly check: boolean;
}

export interface IndexBuildResult {
  readonly up_to_date?: undefined;
  readonly stats: IndexStats;
  readonly corpus_hash: string;
  readonly minted_ids: readonly MintedId[];
  readonly next_steps: readonly string[];
}

export interface IndexCheckResult {
  readonly up_to_date: true;
  readonly corpus_hash: string;
  readonly next_steps: readonly string[];
}

export type IndexCommandResult = IndexBuildResult | IndexCheckResult;

async function freshBuild(store: VolumeStore): Promise<{
  document: IndexDocument;
  mintedIds: readonly MintedId[];
}> {
  const { document, mintedIds } = await new StructuralIndexer().build(store);
  return { document, mintedIds };
}

export async function runIndexCommand(
  store: VolumeStore,
  options: IndexCommandOptions,
): Promise<IndexCommandResult> {
  if (options.check) {
    const { document } = await freshBuild(store);
    const stored = await store.readCorpusIndex<IndexDocument>();
    if (!stored || stored.corpus_hash !== document.corpus_hash) {
      throw new StaleIndexError(stored?.corpus_hash, document.corpus_hash);
    }
    return {
      up_to_date: true,
      corpus_hash: document.corpus_hash,
      next_steps: ["Index is up to date. No action needed."],
    };
  }

  const { document, mintedIds } = await new StructuralIndexer().reindex(store);
  return {
    stats: document.stats,
    corpus_hash: document.corpus_hash,
    minted_ids: mintedIds,
    next_steps: [
      "Volumes are now indexed and discoverable.",
      'Call `shadow find "<task>"` to reason over them, or `shadow volumes` to list them.',
    ],
  };
}
