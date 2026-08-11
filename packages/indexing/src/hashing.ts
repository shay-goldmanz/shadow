/**
 * Content hashing, post-order (`docs/INDEXING.md`, "HASH, post-order").
 *
 * `content_hash` covers a node's own text, excluding descendants;
 * `subtree_hash` folds in descendant hashes so an edit anywhere below a
 * node changes every ancestor's `subtree_hash` up to the root. Hashes
 * exist for citation staleness and change detection — not for skipping
 * work (D11a): every build recomputes every hash.
 */

import { sliceBytesToText } from "./byte-text.ts";
import { normalizeForHashing } from "./normalize.ts";
import type { Span } from "./types.ts";

function sha256Hex(input: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(input);
  return hasher.digest("hex");
}

/** Prefix a raw hex digest the way every hash in `index.json` is formatted. */
export function formatHash(hex: string): string {
  return `sha256:${hex}`;
}

/**
 * The bytes of `span` not covered by any of `childSpans`. Children are
 * expected to be contiguous, non-overlapping sub-ranges of `span` (which
 * is exactly what `spans.ts` produces), but this walks gaps generically
 * rather than assuming that shape, per `docs/INDEXING.md`'s definition:
 * "own_text(v) = bytes in v.span not covered by any child".
 */
export function ownText(bodyBytes: Uint8Array, span: Span, childSpans: readonly Span[]): string {
  const sorted = childSpans.toSorted((a, b) => a.start_byte - b.start_byte);
  const parts: string[] = [];
  let cursor = span.start_byte;
  for (const child of sorted) {
    if (child.start_byte > cursor) {
      parts.push(sliceBytesToText(bodyBytes, cursor, child.start_byte));
    }
    cursor = Math.max(cursor, child.end_byte);
  }
  if (cursor < span.end_byte) {
    parts.push(sliceBytesToText(bodyBytes, cursor, span.end_byte));
  }
  return parts.join("");
}

/** `content_hash`: sha256 of the normalized own text. */
export function computeContentHash(text: string): string {
  return formatHash(sha256Hex(normalizeForHashing(text)));
}

/** Combine a set of already-formatted hash strings, in the given order, into one. Shared by `subtree_hash`, `volume_hash`, and `corpus_hash` — all "sha256(concat(...))" over child hashes. */
export function combineHashes(hashes: readonly string[]): string {
  return formatHash(sha256Hex(hashes.join("")));
}

/** `subtree_hash = sha256(content_hash || concat(child subtree_hashes))`. */
export function computeSubtreeHash(
  contentHash: string,
  childSubtreeHashes: readonly string[],
): string {
  return combineHashes([contentHash, ...childSubtreeHashes]);
}

/** `volume_hash = sha256(concat(chapter subtree_hashes, slug order))`. */
export function computeVolumeHash(chapterSubtreeHashesInSlugOrder: readonly string[]): string {
  return combineHashes(chapterSubtreeHashesInSlugOrder);
}

/** `corpus_hash = sha256(concat(volume_hashes, slug order))`. */
export function computeCorpusHash(volumeHashesInSlugOrder: readonly string[]): string {
  return combineHashes(volumeHashesInSlugOrder);
}
