/** Pure assembly of the top-level `IndexDocument` from its already-built volumes. */

import { computeCorpusHash } from "./hashing.ts";
import { INDEX_SCHEMA_VERSION, type IndexDocument, type VolumeIndexNode } from "./types.ts";

export function buildIndexDocument(
  volumes: readonly VolumeIndexNode[],
  generatedAt: Date = new Date(),
): IndexDocument {
  const chapters = volumes.reduce((sum, volume) => sum + volume.chapter_count, 0);
  const tokens = volumes.reduce(
    (sum, volume) =>
      sum + volume.chapters.reduce((chapterSum, chapter) => chapterSum + chapter.tokens, 0),
    0,
  );
  return {
    schema_version: INDEX_SCHEMA_VERSION,
    generated_at: generatedAt.toISOString(),
    corpus_hash: computeCorpusHash(volumes.map((volume) => volume.volume_hash)),
    stats: { volumes: volumes.length, chapters, tokens },
    volumes,
  };
}
