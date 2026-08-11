/**
 * Check 4 — contradiction (D14): "chapters whose `when_to_use` overlap but
 * whose guidance conflicts, surfaced for the operator to reconcile or
 * resolve with `supersedes`." Model-backed — deciding whether two
 * chapters' actual guidance conflicts is judgment, not something a string
 * comparison can answer (two chapters can share a `when_to_use` and simply
 * cover complementary ground).
 *
 * **Two-stage, to keep the model calls bounded.** A corpus-wide O(n²)
 * judge call per volume would cost real inference for chapters that
 * plainly have nothing to do with each other. This check reuses check 1's
 * similarity measure (`lint-similarity.ts`) as a *cheap pre-filter*: only
 * sibling pairs whose `when_to_use` overlap at or above
 * `DEFAULT_OVERLAP_THRESHOLD` (deliberately lower than check 1's 0.85 —
 * "overlapping scope" is a much weaker bar than "near-duplicate") go on to
 * cost a judge call at all. Pairs already reconciled via `supersedes` are
 * skipped outright — D14 names that as the resolution mechanism, so a
 * pair that already uses it is not an unresolved contradiction.
 *
 * Needs chapter bodies — `when_to_use` deliberately does not describe
 * content (D11a), so judging whether *guidance* conflicts requires the
 * actual prose, fetched through `store` the same way `navigator.ts` reads
 * chapter bodies for passages.
 */

import { toChapterSlug, toVolumeSlug, type VolumeStore } from "@shadow/core";
import type { StructuredGenerationPort } from "@shadow/model";
import { z } from "zod";
import { pairs } from "./lint-pairs.ts";
import { tokenSetJaccard } from "./lint-similarity.ts";
import type { LintCheckResult, LintFinding } from "./lint-types.ts";
import type { ChapterIndexNode, IndexDocument } from "./types.ts";

/** Lower than check 1's 0.85 by design — this is a pre-filter for "worth asking the judge about", not the collision threshold itself. */
export const DEFAULT_OVERLAP_THRESHOLD = 0.3;

const judgmentSchema = z.object({
  conflicting: z.boolean(),
  reason: z.string().describe("one sentence explaining the verdict either way"),
});

export interface ContradictionOptions {
  /** `when_to_use` overlap at or above this value is worth a judge call. Defaults to `DEFAULT_OVERLAP_THRESHOLD`. */
  readonly overlapThreshold?: number;
}

export interface ContradictionFindingData {
  readonly overlap: number;
  readonly reason: string;
}

function resolvedBySupersedes(a: ChapterIndexNode, b: ChapterIndexNode): boolean {
  return (a.supersedes ?? []).includes(b.node_id) || (b.supersedes ?? []).includes(a.node_id);
}

/** Run the contradiction check over every volume's sibling chapter pairs. */
export async function checkContradiction(
  document: IndexDocument,
  store: VolumeStore,
  port: StructuredGenerationPort,
  options: ContradictionOptions = {},
): Promise<LintCheckResult> {
  const overlapThreshold = options.overlapThreshold ?? DEFAULT_OVERLAP_THRESHOLD;
  const findings: LintFinding[] = [];

  for (const volume of document.volumes) {
    const volumeSlug = toVolumeSlug(volume.volume_id);
    for (const [a, b] of pairs(volume.chapters)) {
      if (!a.when_to_use || !b.when_to_use || resolvedBySupersedes(a, b)) {
        continue;
      }
      const overlap = tokenSetJaccard(a.when_to_use, b.when_to_use);
      if (overlap < overlapThreshold) {
        continue;
      }

      const [chapterA, chapterB] = await Promise.all([
        store.getChapter(volumeSlug, toChapterSlug(a.slug)),
        store.getChapter(volumeSlug, toChapterSlug(b.slug)),
      ]);

      const { object } = await port.generate({
        schema: judgmentSchema,
        schemaName: "contradiction_judgment",
        system:
          "Two documentation chapters have overlapping applicability. Decide whether their actual guidance conflicts — recommends incompatible things for the same situation — rather than merely covering adjacent or complementary ground.",
        prompt: `Chapter A: "${a.title}" (when_to_use: ${a.when_to_use})\n${chapterA.body}\n\n---\n\nChapter B: "${b.title}" (when_to_use: ${b.when_to_use})\n${chapterB.body}`,
      });

      if (object.conflicting) {
        findings.push({
          code: "contradiction",
          severity: "warning",
          message: `"${a.title}" and "${b.title}" overlap in when_to_use and give conflicting guidance: ${object.reason}. Reconcile them or resolve with supersedes.`,
          nodeIds: [a.node_id, b.node_id],
          data: { overlap, reason: object.reason } satisfies ContradictionFindingData,
        });
      }
    }
  }

  return { checkId: "contradiction", requiresModel: true, findings };
}
