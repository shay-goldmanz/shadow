/**
 * Turns a `{sourceId, quote}` reference into a real, resolved
 * `EvidenceSpan` — the mechanical half of "Shadow writes only what it can
 * cite" (`ARCHITECTURE.md`'s invariant for `@shadow/agent`, lifted here so
 * any caller — not just Shadow's own turn loop — gets the same builder).
 *
 * This is deliberately the *only* place this package constructs a
 * `TextQuoteSelector` from a raw quote. It never invents `prefix`/`suffix`
 * context or an `anchorStatus` — both are derived from the source's actual,
 * already-persisted snapshot text via `resolveSelector` (the same function
 * C2 uses to verify a span at audit time), so a span built here resolves
 * identically when the audit re-checks it. A quote that is not an exact
 * substring of the cited source's current snapshot fails loudly
 * (`UnresolvedEvidenceQuoteError`) rather than being silently dropped or
 * fuzzy-matched — binding happens *before* writing, so there is no later
 * chance to notice a paraphrased quote slipped through.
 *
 * Originally `@shadow/agent`'s `evidence-binding.ts`. Lifted here (Rule Book
 * Creator) because rule-book extraction needs the identical quote-to-span
 * mechanics against a file-witnessed source, with no session or chapter
 * directive involved. `@shadow/agent`'s `buildEvidenceSpan` is now a thin
 * wrapper over `buildSpanFromQuote`.
 */

import type { VolumeSlug } from "@shadow/core";
import { DEFAULT_ANCHORING_CONFIG, resolveSelector } from "./anchoring.ts";
import { UnknownSourceError, UnresolvedEvidenceQuoteError } from "./errors.ts";
import { toSourceId } from "./ids.ts";
import type { EvidenceStore } from "./store.ts";
import type { EvidenceSpan, TextQuoteSelector } from "./types.ts";

/** A `{sourceId, quote}` reference, the shape every caller of `buildSpanFromQuote` supplies. */
export interface SpanFromQuoteInput {
  readonly sourceId: string;
  readonly quote: string;
}

/**
 * Resolve `input` (a `{sourceId, quote}` reference) against `sourceId`'s
 * currently-pinned snapshot in `volume`'s evidence ledger, and build the
 * `EvidenceSpan` a `Claim` (or rule-book equivalent) carries.
 *
 * @throws {UnknownSourceError} if `input.sourceId` does not resolve in the ledger.
 * @throws {UnresolvedEvidenceQuoteError} if `input.quote` is not an exact substring of the pinned snapshot.
 */
export async function buildSpanFromQuote(
  evidenceStore: EvidenceStore,
  volume: VolumeSlug,
  label: string,
  input: SpanFromQuoteInput,
): Promise<EvidenceSpan> {
  const sourceId = toSourceId(input.sourceId);

  const source = await evidenceStore.getSource(volume, sourceId).catch((cause: unknown) => {
    throw new UnknownSourceError(label, input.sourceId, cause);
  });

  const snapshotHash = source.snapshot.normalizedTextSha256;
  const snapshotText = await evidenceStore.getSnapshotText(volume, snapshotHash);

  const contextChars = DEFAULT_ANCHORING_CONFIG.contextChars;
  const index = snapshotText.indexOf(input.quote);
  if (index === -1) {
    throw new UnresolvedEvidenceQuoteError(label, input.sourceId, input.quote);
  }
  const end = index + input.quote.length;

  const prefix = snapshotText.slice(Math.max(0, index - contextChars), index);
  const suffix = snapshotText.slice(end, Math.min(snapshotText.length, end + contextChars));

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
