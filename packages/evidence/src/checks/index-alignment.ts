/**
 * C4 — index alignment (Tier 2, `docs/EVIDENCE.md`): every claim in an
 * index node's routing metadata (`when_to_use`, summaries) appears in, or
 * is entailed by, the chapter beneath it. D9's argument for why this is
 * ours and matters: "the index is generated content too, and it is what a
 * consuming agent retrieves and reasons over first. An ungrounded node
 * summary would poison retrieval while the chapter beneath it stayed
 * clean."
 *
 * **Blocking**, on the same footing as C1a/C1b/C2/C3 — `docs/EVIDENCE.md`'s
 * verdict sentence only names C1a/C1b/C2/C3 explicitly, but `checks/types.ts`'s
 * `CheckOutcome.blocking` doc calls out C5 alone as the non-blocking
 * example, and D9 frames C4 as a real correctness check on the same footing
 * as the other three ("poison retrieval" is not a warning-grade failure
 * mode). Read as an incomplete enumeration rather than a deliberate
 * exemption; flagged in the delivery report for spec review.
 *
 * **This package owns no index data.** `@shadow/indexing` is off-limits
 * here — the caller supplies whatever routing-metadata fragments
 * (`when_to_use`, node summaries) it wants checked as plain strings.
 *
 * Memoized all-or-nothing, unlike C1b/C3/C5's per-item hashing: "C4 runs
 * only if the chapter's routing metadata changed." `computeRoutingMetadataHash`
 * is the caller's tool for detecting that; the caller persists the result
 * (`AuditRecord.routingMetadataHash`) and only invokes `checkIndexAlignment`
 * when the hash differs from what it stored last time — this file does not
 * make that decision itself, since the "did anything change" question needs
 * the *previous* audit record, which lives in `checks/tier2.ts`'s
 * orchestration, not here.
 *
 * **The memoization key folds in `chapterClaims`, not just the routing-
 * metadata text (I-3, Wave 2 review).** C4's actual verdict depends on
 * *both* the node-summary fragments and the chapter claims they're checked
 * against — `checkIndexAlignment`'s `fragments` pairs each summary with
 * `chapterClaims`. Hashing only the summaries meant deleting or restating a
 * claim that supported a `when_to_use`, while leaving frontmatter untouched,
 * left `computeRoutingMetadataHash`'s key unchanged — so C4 replayed a stale
 * *pass* on a blocking check even though the claims underneath the summary
 * had moved. Folding `chapterClaims` in closes that: any claim edit that
 * changes what C4 would judge also changes the key.
 */

import { type Sha256Digest, sha256Of } from "../digest.ts";
import type { IndexAlignmentChecker, IndexAlignmentInput } from "../ports.ts";
import type { CheckIssue, CheckOutcome } from "./types.ts";

export interface IndexAlignmentBundle {
  /** One entry per routing-metadata fragment to check (e.g. `when_to_use`, each node summary), all sharing `chapterClaims`. */
  readonly fragments: readonly IndexAlignmentInput[];
  readonly checker: IndexAlignmentChecker;
}

/**
 * Hash of the routing-metadata text *and* the chapter claims it is judged
 * against — the all-or-nothing memoization key (see module doc's I-3 note).
 * Both arguments are what `checkIndexAlignment`'s verdict actually depends
 * on, so both must be in the key or a claim-only edit goes undetected.
 */
export function computeRoutingMetadataHash(
  nodeSummaries: readonly string[],
  chapterClaims: readonly string[],
): Sha256Digest {
  return sha256Of(JSON.stringify([nodeSummaries, chapterClaims]));
}

/** Run C4 over one chapter's index routing metadata, in one batched call. */
export async function checkIndexAlignment(bundle: IndexAlignmentBundle): Promise<CheckOutcome> {
  const { fragments, checker } = bundle;
  if (fragments.length === 0) {
    return { checkId: "C4", tier: 2, blocking: true, passed: true, issues: [] };
  }

  const verdicts = await checker.check(fragments);
  if (verdicts.length !== fragments.length) {
    throw new Error(
      `IndexAlignmentChecker returned ${verdicts.length} verdicts for ${fragments.length} fragments`,
    );
  }

  const issues: CheckIssue[] = [];
  verdicts.forEach((verdict, i) => {
    if (verdict.aligned) return;
    if (verdict.unsupportedAssertions.length === 0) {
      issues.push({
        code: "index-misalignment",
        message: `Index routing metadata fragment ${i + 1} is not aligned with the chapter body`,
      });
      return;
    }
    for (const assertion of verdict.unsupportedAssertions) {
      issues.push({
        code: "index-misalignment",
        message: `Index routing metadata claims "${assertion}", which the chapter does not support or entail`,
      });
    }
  });

  return { checkId: "C4", tier: 2, blocking: true, passed: issues.length === 0, issues };
}
