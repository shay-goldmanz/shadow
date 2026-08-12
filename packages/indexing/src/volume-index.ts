/** Pure assembly of a volume's `VolumeIndexNode` from its already-built chapters. */

import { computeVolumeHash } from "./hashing.ts";
import type { ChapterIndexNode, VolumeIndexNode } from "./types.ts";

export interface BuildVolumeIndexNodeInput {
  readonly volumeSlug: string;
  readonly volumeTitle: string;
  /** OKF v0.2 concept type (OKF §4.1). */
  readonly volumeType?: string;
  readonly whenToUse: string | undefined;
  readonly notFor: string | undefined;
  readonly keywords: readonly string[] | undefined;
  /** Chapters, already sorted by slug (`volume_hash` is order-sensitive). */
  readonly chapters: readonly ChapterIndexNode[];
}

export function buildVolumeIndexNode(input: BuildVolumeIndexNodeInput): VolumeIndexNode {
  return {
    volume_id: input.volumeSlug,
    title: input.volumeTitle,
    type: input.volumeType,
    when_to_use: input.whenToUse,
    not_for: input.notFor,
    keywords: input.keywords,
    chapter_count: input.chapters.length,
    volume_hash: computeVolumeHash(input.chapters.map((chapter) => chapter.subtree_hash)),
    chapters: input.chapters,
  };
}
