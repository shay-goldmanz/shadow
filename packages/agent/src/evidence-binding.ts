/**
 * Turns a directive's `{sourceId, quote}` into a real, resolved
 * `EvidenceSpan` — the mechanical half of "Shadow writes only what it can
 * cite" (`ARCHITECTURE.md`'s invariant for this package).
 *
 * This is deliberately the *only* place `@shadow/agent` constructs a
 * `TextQuoteSelector`, but the actual mechanics — no invented `prefix`/
 * `suffix` context, `anchorStatus` derived from `resolveSelector`, an
 * `UnresolvedEvidenceQuoteError` on a non-verbatim quote — now live in
 * `@shadow/evidence`'s `buildSpanFromQuote` (`span-binding.ts`), lifted out
 * (Rule Book Creator) so rule-book extraction can build spans against
 * file-witnessed sources with the identical guarantees, with no session or
 * chapter directive involved. This function is a thin wrapper so existing
 * agent callers (and their imports) are unaffected.
 *
 * @throws {UnknownSourceError} if `input.sourceId` does not resolve in the ledger.
 * @throws {UnresolvedEvidenceQuoteError} if `input.quote` is not an exact substring of the pinned snapshot.
 */

import type { VolumeSlug } from "@shadow/core";
import { buildSpanFromQuote, type EvidenceSpan, type EvidenceStore } from "@shadow/evidence";
import type { ChapterClaimEvidenceInput } from "./directives.ts";

export async function buildEvidenceSpan(
  evidenceStore: EvidenceStore,
  volume: VolumeSlug,
  label: string,
  input: ChapterClaimEvidenceInput,
): Promise<EvidenceSpan> {
  return buildSpanFromQuote(evidenceStore, volume, label, input);
}
