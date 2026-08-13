/**
 * Turns a directive's `{sourceId, quote}` into a real, resolved
 * `EvidenceSpan` — the mechanical half of "Shadow writes only what it can
 * cite" (`ARCHITECTURE.md`'s invariant for this package).
 *
 * This is deliberately the *only* place `@shadow/agent` constructs a
 * `TextQuoteSelector`. It never invents `prefix`/`suffix` context or an
 * `anchorStatus` — both are derived from the source's actual, already-
 * persisted snapshot text via `@shadow/evidence`'s own `resolveSelector`
 * (the same function C2 uses to verify a span at audit time), so a span
 * built here resolves identically when the audit re-checks it. A quote
 * that is not an exact substring of the cited source's current snapshot
 * fails loudly (`UnresolvedEvidenceQuoteError`) rather than being silently
 * dropped or fuzzy-matched — binding happens *before* writing (the
 * shadow-write-volumes skill's §4), so there is no later chance to notice a
 * paraphrased quote slipped through.
 */

import type { VolumeSlug } from "@shadow/core";
import {
  type EvidenceSpan,
  type EvidenceStore,
  resolveSelector,
  type TextQuoteSelector,
  toSourceId,
} from "@shadow/evidence";
import type { ChapterClaimEvidenceInput } from "./directives.ts";
import { UnknownSourceError, UnresolvedEvidenceQuoteError } from "./errors.ts";

/** How much snapshot context surrounds a quote in its selector's `prefix`/`suffix` — matches `@shadow/evidence`'s own `DEFAULT_ANCHORING_CONFIG.contextChars`, so a span built here anchors identically under the audit's default configuration. */
const CONTEXT_CHARS = 32;

/**
 * Resolve `input` (a directive's evidence reference) against `sourceId`'s
 * currently-pinned snapshot in `volume`'s evidence ledger, and build the
 * `EvidenceSpan` a `Claim` carries.
 *
 * @throws {UnknownSourceError} if `input.sourceId` does not resolve in the ledger.
 * @throws {UnresolvedEvidenceQuoteError} if `input.quote` is not an exact substring of the pinned snapshot.
 */
export async function buildEvidenceSpan(
  evidenceStore: EvidenceStore,
  volume: VolumeSlug,
  label: string,
  input: ChapterClaimEvidenceInput,
): Promise<EvidenceSpan> {
  const sourceId = toSourceId(input.sourceId);

  const source = await evidenceStore.getSource(volume, sourceId).catch((cause: unknown) => {
    throw new UnknownSourceError(label, input.sourceId, cause);
  });

  const snapshotHash = source.snapshot.normalizedTextSha256;
  const snapshotText = await evidenceStore.getSnapshotText(volume, snapshotHash);

  const index = snapshotText.indexOf(input.quote);
  if (index === -1) {
    throw new UnresolvedEvidenceQuoteError(label, input.sourceId, input.quote);
  }
  const end = index + input.quote.length;

  const prefix = snapshotText.slice(Math.max(0, index - CONTEXT_CHARS), index);
  const suffix = snapshotText.slice(end, Math.min(snapshotText.length, end + CONTEXT_CHARS));

  const selector: TextQuoteSelector = {
    type: "TextQuoteSelector",
    exact: input.quote,
    ...(prefix.length > 0 ? { prefix } : {}),
    ...(suffix.length > 0 ? { suffix } : {}),
  };

  // Resolve immediately so `refinedBy` is populated (the fast-path cache
  // C2 re-validates on every later audit) and so `anchorStatus` reflects
  // reality rather than an assumed "anchored" — freshly built from an
  // `indexOf` hit, it always resolves, but going through the same resolver
  // C2 uses keeps this span's shape identical to what the audit produces.
  const resolution = resolveSelector(selector, snapshotText);

  return {
    sourceId,
    snapshotHash,
    selector: {
      ...selector,
      ...(resolution.start !== undefined && resolution.end !== undefined
        ? {
            refinedBy: {
              type: "TextPositionSelector",
              start: resolution.start,
              end: resolution.end,
            },
          }
        : {}),
    },
    relation: "supports",
    anchorStatus: resolution.status,
  };
}
