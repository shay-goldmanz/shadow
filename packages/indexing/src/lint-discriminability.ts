/**
 * Check 1 — discriminability (D14): "flag sibling chapters whose
 * `when_to_use` similarity exceeds 0.85." Pure computation, no model — the
 * check that catches the PageIndex failure mode (generated summaries
 * collapsing into each other) before it degrades retrieval, per D14's
 * whole premise: bad frontmatter silently degrades retrieval and nothing
 * else in the system would notice.
 *
 * "Sibling" = chapters in the same volume — the unit STAGE 3 (NAVIGATE)
 * actually routes between (`docs/INDEXING.md`). Chapters in different
 * volumes are never compared: STAGE 2 (ROUTE) has already separated them
 * before STAGE 3 sees either, so their `when_to_use` similarity has no
 * bearing on routing quality.
 */

import { pairs } from "./lint-pairs.ts";
import { tokenSetJaccard } from "./lint-similarity.ts";
import type { LintCheck, LintCheckResult, LintFinding } from "./lint-types.ts";
import type { ChapterIndexNode, IndexDocument } from "./types.ts";

/** D14's own number: "flag pairs above 0.85." */
export const DEFAULT_DISCRIMINABILITY_THRESHOLD = 0.85;

export interface DiscriminabilityOptions {
  /** Similarity above this value is flagged. Configurable per D14 ("make the threshold configurable"). Defaults to `DEFAULT_DISCRIMINABILITY_THRESHOLD`. */
  readonly threshold?: number;
}

export interface DiscriminabilityFindingData {
  readonly similarity: number;
  readonly threshold: number;
}

/** Run the discriminability check over every volume's sibling chapter pairs. Pairs where either chapter has no `when_to_use` are skipped — nothing to compare, and a missing routing field is a different problem than a collision. */
export function checkDiscriminability(
  document: IndexDocument,
  options: DiscriminabilityOptions = {},
): LintCheckResult {
  const threshold = options.threshold ?? DEFAULT_DISCRIMINABILITY_THRESHOLD;
  const findings: LintFinding[] = [];

  for (const volume of document.volumes) {
    for (const [a, b] of pairs(volume.chapters)) {
      const similarity = compareChapters(a, b);
      if (similarity === undefined) {
        continue;
      }
      if (similarity > threshold) {
        findings.push({
          code: "discriminability-collision",
          severity: "warning",
          message: `"${a.title}" and "${b.title}" have near-identical when_to_use (similarity ${similarity.toFixed(3)} > ${threshold}) — a router cannot reliably tell them apart`,
          nodeIds: [a.node_id, b.node_id],
          data: { similarity, threshold } satisfies DiscriminabilityFindingData,
        });
      }
    }
  }

  return { checkId: "discriminability", requiresModel: false, findings };
}

function compareChapters(a: ChapterIndexNode, b: ChapterIndexNode): number | undefined {
  if (!a.when_to_use || !b.when_to_use) {
    return undefined;
  }
  return tokenSetJaccard(a.when_to_use, b.when_to_use);
}

export const discriminabilityCheck: LintCheck<IndexDocument> = {
  id: "discriminability",
  requiresModel: false,
  run: (document) => checkDiscriminability(document),
};
