/**
 * Check 3 — orphan detection (D14): "chapters never returned by any
 * probe." Pure computation, no model — this check itself never calls a
 * model; it consumes a *coverage set* (the union of every citation
 * returned across a run of probes) computed elsewhere and asks a single
 * question of the already-built `IndexDocument`: which chapters does that
 * set never mention?
 *
 * **Why the coverage set is an input, not something this check derives.**
 * "Never returned by any probe" only means something once probes have
 * actually run, and probes are check 2's job (self-retrieval), which is
 * necessarily model-backed (D14: "generate a plausible task per chapter").
 * Splitting orphan detection out from self-retrieval this way is what lets
 * it stay genuinely zero-LLM and independently testable (`--offline`'s
 * "the pure ones must run with no model at all"): this file has no
 * `@shadow/model` import and never will.
 *
 * `lint.ts`'s orchestrator wires the two together in the normal online
 * path — it runs self-retrieval first, unions every probe's citation
 * node_ids into a coverage set, then calls `checkOrphans` with it. Calling
 * `checkOrphans` with an **empty** coverage set (as `--offline` mode must,
 * having run no probes) still returns a well-defined answer: every chapter
 * is reported orphaned. That is not a false alarm — it is an honest "this
 * corpus has never been probed" signal, distinguishable from a *real*
 * orphan (found by an online run that probed everything and still missed
 * one) only by the caller knowing which mode produced the coverage set.
 * `OrphanFindingData.probed` carries that distinction through to the
 * finding itself rather than leaving it implicit.
 */

import { flattenIndex } from "./closure.ts";
import type { LintCheckResult, LintFinding } from "./lint-types.ts";
import type { IndexDocument } from "./types.ts";

export interface OrphanFindingData {
  /** `false` when the coverage set behind this finding was empty (e.g. `--offline`, or self-retrieval never ran) — this chapter wasn't rejected by probing, it was simply never probed at all. */
  readonly probed: boolean;
}

/**
 * A chapter node_id counts as "covered" if `coveredNodeIds` contains its
 * own node_id *or* the node_id of any section beneath it — a probe that
 * cited one of a chapter's sections still found that chapter, per
 * `docs/INDEXING.md`'s "return passages... not whole chapters" rule (a
 * section-level citation is a real, successful retrieval of its parent
 * chapter, not a miss).
 */
export function checkOrphans(
  document: IndexDocument,
  coveredNodeIds: ReadonlySet<string>,
): LintCheckResult {
  const flat = flattenIndex(document);
  const probed = coveredNodeIds.size > 0;
  const findings: LintFinding[] = [];

  for (const volume of document.volumes) {
    for (const chapter of volume.chapters) {
      if (isCovered(chapter.node_id, coveredNodeIds, flat)) {
        continue;
      }
      findings.push({
        code: "orphan-chapter",
        severity: "warning",
        message: probed
          ? `"${chapter.title}" was never returned by any self-retrieval probe across the run — check its when_to_use, or the tasks probing near it`
          : `"${chapter.title}" has not been probed by any self-retrieval run yet`,
        nodeIds: [chapter.node_id],
        data: { probed } satisfies OrphanFindingData,
      });
    }
  }

  return { checkId: "orphan", requiresModel: false, findings };
}

function isCovered(
  chapterNodeId: string,
  coveredNodeIds: ReadonlySet<string>,
  flat: ReadonlyMap<string, { readonly childIds: readonly string[] }>,
): boolean {
  if (coveredNodeIds.has(chapterNodeId)) {
    return true;
  }
  const stack = [...(flat.get(chapterNodeId)?.childIds ?? [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) {
      continue;
    }
    if (coveredNodeIds.has(id)) {
      return true;
    }
    stack.push(...(flat.get(id)?.childIds ?? []));
  }
  return false;
}
