/**
 * Shared corpus-index loading. Every read-side command (`volumes`,
 * `chapters`, `find`, `read`, `grep`) starts here — one place turns "no
 * index yet" into the typed `IndexMissingError` (with its `next_steps`)
 * instead of every command re-deriving that check.
 */

import type { VolumeStore } from "@shadow/core";
import type { IndexDocument } from "@shadow/indexing";
import { IndexMissingError } from "./errors.ts";

/**
 * Load the corpus-wide index document.
 * @throws {IndexMissingError} if `shadow index` has never been run.
 */
export async function loadCorpusIndex(store: VolumeStore): Promise<IndexDocument> {
  const document = await store.readCorpusIndex<IndexDocument>();
  if (!document) {
    throw new IndexMissingError();
  }
  return document;
}
