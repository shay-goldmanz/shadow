/**
 * C2 — source integrity (Tier 0, `docs/EVIDENCE.md`): every `sourceId` and
 * `snapshotHash` exists; re-hashing a snapshot reproduces its filename;
 * every `selector.exact` resolves **exactly** in its pinned snapshot. Plus
 * the numeric sub-check: every numeral in a claim appears in a *resolved*
 * cited span within 5% relative tolerance.
 *
 * Takes an `EvidenceLookup` rather than the store directly, so this stays a
 * pure, filesystem-free function testable with an in-memory fake — the
 * store (`../store.ts`) is just one implementation of that lookup.
 *
 * **Orphan semantics split in two, per D22 (Wave 1 review).** Two distinct
 * situations used to collapse into one blocking `unresolved-selector`
 * finding:
 *
 * - `selector.exact` fails to resolve **in its pinned snapshot**
 *   (`unresolved-selector`, blocking): snapshots are immutable and
 *   content-addressed, so if the quote isn't in the exact bytes stored
 *   under `span.snapshotHash`, the citation was fabricated or the snapshot
 *   was tampered with. Neither is survivable — this is what C2 exists to
 *   catch.
 * - the **source has drifted** since this evidence was captured
 *   (`source-drifted`, non-blocking warning): `source.snapshot`'s *current*
 *   `normalizedTextSha256` no longer matches `span.snapshotHash`, meaning
 *   the source record has since been updated to point at a newer snapshot
 *   (see the ledger's `source.drifted` event) while this claim still pins
 *   the older one. The operator did nothing wrong and the world moved; the
 *   pinned snapshot itself is untouched and still resolves normally, so
 *   this is reported as staleness, not fabrication. Detected independently
 *   of whether the selector resolves, since the two are orthogonal: a
 *   drifted source's *old* pinned snapshot still contains exactly what it
 *   always did.
 *
 * **Exact-only resolution, per D24 (Wave 2 review, C-1).** Resolution used
 * to run with fuzzy matching enabled (`resolveSelector`'s step 3), which
 * demonstrably lets a fabricated quote through: a snapshot saying "an 8 px
 * grid" cited by a claim whose `selector.exact` fabricates "a 4 px grid"
 * (edit distance 2) resolved as `anchored-fuzzy` — a mere warning — instead
 * of failing. But fuzzy resolution is only ever *coherent* against text
 * that has genuinely drifted; a pinned snapshot is immutable and
 * content-addressed, so there is no legitimate way for a quote to be
 * nearly-but-not-quite present in it (the cooperative write path already
 * requires an exact `indexOf` at bind time). So `checkEvidenceSpan` below
 * resolves with `allowFuzzy: false` — an unresolvable selector against a
 * pinned snapshot has exactly one cause (fabrication or tampering) and
 * blocks, with no fuzzy escape hatch. Fuzzy anchoring remains available in
 * `anchoring.ts` for the separate drift/re-anchoring path against
 * *refetched* text, which is the only place it was ever coherent.
 *
 * **The judge never sees `selector.exact` (D24, part 2).** `resolveEvidenceText`
 * below is the single choke point through which any verifier — this file's
 * own numeric sub-check, and `entailment-relevance.ts`'s C3 judge — reads
 * evidence text. All of them read the *resolved* slice of the stored
 * snapshot, never the claim's own writer-supplied copy of the quote. Handing
 * a verifier the thing it is verifying makes the check circular and
 * incapable of failing; that is exactly the hole this closes.
 */

import { type AnchoringConfig, resolveSelector } from "../anchoring.ts";
import { type Sha256Digest, sha256Of } from "../digest.ts";
import type { SourceId } from "../ids.ts";
import {
  checkNumericConsistency,
  DEFAULT_NUMERIC_TOLERANCE,
  type NumericCheckResult,
} from "../numeric.ts";
import type { Claim, ClaimSidecar, EvidenceSpan, SourceRecord } from "../types.ts";
import type { CheckIssue, CheckOutcome, EvidenceCheck } from "./types.ts";

/** The narrow read surface C2 needs. Implemented by `EvidenceStore`, but kept separate so this check has no filesystem dependency of its own. */
export interface EvidenceLookup {
  getSource(id: SourceId): SourceRecord | undefined;
  /** The raw normalized-text content stored at `normalizedTextSha256`, or `undefined` if no such snapshot exists. */
  getSnapshotText(normalizedTextSha256: Sha256Digest): string | undefined;
}

export interface SourceIntegrityInput {
  readonly sidecar: ClaimSidecar;
  readonly lookup: EvidenceLookup;
  readonly anchoringConfig?: AnchoringConfig;
  readonly numericTolerance?: number;
}

export interface SourceIntegrityData {
  /** Per-claim numeric sub-check results, keyed by claim label. */
  readonly numeric: Readonly<Record<string, NumericCheckResult>>;
}

/**
 * Resolve one evidence span's `selector` against its pinned snapshot and
 * return the resolved **stored** text — never `selector.exact`, which is
 * writer-supplied and therefore exactly the thing a verifier must not be
 * handed (D24). Returns `undefined` if the span doesn't cleanly resolve
 * (missing source, missing snapshot, a tampered snapshot, or an orphaned
 * selector); `checkEvidenceSpan` below is what reports *why* as a C2
 * finding, but any other caller (`entailment-relevance.ts`'s C3 judge) can
 * use this directly without needing its own copy of the resolution logic.
 *
 * Exact-only (D24): resolves with `allowFuzzy: false`, since a pinned,
 * immutable snapshot has no legitimate "nearly but not quite present" case
 * — fuzzy anchoring is reserved for the drift/re-anchoring path against
 * refetched text, never for verifying evidence against the snapshot it was
 * originally cited from.
 */
export function resolveEvidenceText(
  span: Pick<EvidenceSpan, "sourceId" | "snapshotHash" | "selector">,
  lookup: EvidenceLookup,
  config?: AnchoringConfig,
): string | undefined {
  const source = lookup.getSource(span.sourceId);
  if (!source) return undefined;
  const snapshotText = lookup.getSnapshotText(span.snapshotHash);
  if (snapshotText === undefined) return undefined;
  if (sha256Of(snapshotText) !== span.snapshotHash) return undefined;
  const resolution = resolveSelector(span.selector, snapshotText, { config, allowFuzzy: false });
  if (
    resolution.status !== "anchored" ||
    resolution.start === undefined ||
    resolution.end === undefined
  ) {
    return undefined;
  }
  return snapshotText.slice(resolution.start, resolution.end);
}

/** Returns the resolved stored text for this span (for the numeric sub-check), or `undefined` if unresolvable — an issue has already been pushed to `issues`/`warnings` in that case. */
function checkEvidenceSpan(
  claim: Claim,
  spanIndex: number,
  lookup: EvidenceLookup,
  config: AnchoringConfig | undefined,
  issues: CheckIssue[],
  warnings: CheckIssue[],
): string | undefined {
  const span = claim.evidence[spanIndex];
  if (!span) return undefined;
  const label = claim.label;

  const source = lookup.getSource(span.sourceId);
  if (!source) {
    issues.push({
      code: "missing-source",
      message: `Claim "${label}" cites source "${span.sourceId}", which does not exist`,
      label,
    });
    return undefined;
  }

  // D22: the source has since been refetched to different content — its
  // record's *current* snapshot pointer no longer matches what this
  // specific evidence span pinned at citation time. This is expected
  // corpus aging (D16), not fabrication: warn and mark the claim stale
  // rather than blocking the chapter. Independent of whatever the
  // resolution check below finds, since the pinned snapshot's own content
  // never changes regardless of what the live source has done since.
  if (source.snapshot.normalizedTextSha256 !== span.snapshotHash) {
    warnings.push({
      code: "source-drifted",
      message: `Claim "${label}"'s evidence pins snapshot "${span.snapshotHash}", but source "${span.sourceId}" has since drifted to "${source.snapshot.normalizedTextSha256}" — claim is stale, refetch queued`,
      label,
    });
  }

  const snapshotText = lookup.getSnapshotText(span.snapshotHash);
  if (snapshotText === undefined) {
    issues.push({
      code: "missing-snapshot",
      message: `Claim "${label}" pins snapshot "${span.snapshotHash}", which does not exist`,
      label,
    });
    return undefined;
  }

  // Re-hash: the content actually stored under this hash must still
  // reproduce it. A mismatch means the snapshot file was tampered with (or
  // corrupted) independent of anything about the source's *current* live
  // content — this is purely "is our own stored copy self-consistent".
  const rehashed = sha256Of(snapshotText);
  if (rehashed !== span.snapshotHash) {
    issues.push({
      code: "tampered-snapshot",
      message: `Snapshot "${span.snapshotHash}" for claim "${label}" no longer hashes to its own filename (got "${rehashed}")`,
      label,
    });
    return undefined;
  }

  // Exact-only (D24): no fuzzy escape hatch against a pinned, immutable
  // snapshot — see the module doc's C-1 note. `resolveEvidenceText`
  // repeats the lookups above internally, which is fine (cheap, and this
  // keeps the resolution logic itself defined in exactly one place).
  const resolvedText = resolveEvidenceText(span, lookup, config);
  if (resolvedText === undefined) {
    issues.push({
      code: "unresolved-selector",
      message: `Claim "${label}"'s evidence selector no longer resolves in its pinned snapshot`,
      label,
    });
  }
  return resolvedText;
}

/** Run C2 (source integrity + numeric sub-check) over one chapter. */
export function checkSourceIntegrity(input: SourceIntegrityInput): CheckOutcome {
  const { sidecar, lookup } = input;
  const tolerance = input.numericTolerance ?? DEFAULT_NUMERIC_TOLERANCE;
  const issues: CheckIssue[] = [];
  const warnings: CheckIssue[] = [];
  const numeric: Record<string, NumericCheckResult> = {};

  for (const claim of sidecar.claims) {
    // D24 (C-1): the numeral comparison below must read the *resolved*
    // stored snapshot slice, never `selector.exact` — the writer's own copy
    // of the quote. A span that fails to resolve contributes nothing here
    // (rather than falling back to its own unverified text), which is what
    // makes a fabricated quote's numerals fail this check too: there is no
    // resolved text left to compare against.
    const resolvedTexts: string[] = [];
    for (let i = 0; i < claim.evidence.length; i++) {
      const resolvedText = checkEvidenceSpan(
        claim,
        i,
        lookup,
        input.anchoringConfig,
        issues,
        warnings,
      );
      if (resolvedText !== undefined) resolvedTexts.push(resolvedText);
    }

    if (claim.evidence.length > 0) {
      const result = checkNumericConsistency(
        claim.decontextualized || claim.text,
        resolvedTexts,
        tolerance,
      );
      numeric[claim.label] = result;
      if (!result.passed) {
        for (const outcome of result.outcomes) {
          if (!outcome.matched) {
            issues.push({
              code: "numeric-mismatch",
              message: `Claim "${claim.label}" states "${outcome.numeral.raw}", which is not within ${Math.round(
                tolerance * 100,
              )}% of any cited value`,
              label: claim.label,
            });
          }
        }
      }
    }
  }

  return {
    checkId: "C2",
    tier: 0,
    blocking: true,
    passed: issues.length === 0,
    issues,
    warnings,
    data: { numeric } satisfies SourceIntegrityData,
  };
}

export const sourceIntegrityCheck: EvidenceCheck<SourceIntegrityInput> = {
  id: "C2",
  tier: 0,
  blocking: true,
  run: checkSourceIntegrity,
};
