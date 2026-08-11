/**
 * The audit gate: `ARCHITECTURE.md`'s invariant for this package is "Shadow
 * writes only what it can cite," and this module is where that is
 * mechanically enforced, not merely intended. `chapter-draft.ts` can
 * persist a *structurally* well-formed chapter, but `publishChapter` is
 * what decides whether it is actually publishable — running
 * `@shadow/evidence`'s full CoE audit (T2.4's `runFullAudit`), applying its
 * conservative-restatement repair loop to whatever is repairable (D9/D21),
 * and only then reindexing.
 *
 * **C4 (index alignment) is not run here.** `runFullAudit`'s
 * `indexNodeSummaries` is left `undefined` — this chapter has no index node
 * yet the *first* time it is published (the index is built *from* it,
 * afterward), and `Tier2AuditInput`'s own doc says to "omit if this chapter
 * has no index node yet." A future re-publish after the chapter is already
 * indexed could pass its current `when_to_use` through, but that is out of
 * this task's scope and does not affect the pass/fail checks that matter
 * here (C1a/C1b/C2/C3).
 *
 * **The repair round is bounded to exactly one retry**, not an iterative
 * fixpoint: audit once; if anything is repairable, restate and audit
 * again; whatever verdict results is final. Repair updates a claim's
 * `text` *and* `decontextualized` together (the sentence a human reads and
 * the string Tier 2 judges are, for a single-sentence claim, the same
 * thing) — changing `decontextualized` changes the claim's `inputHash`
 * (D20's memoization key excludes `text` but not `decontextualized`), which
 * is exactly what forces the second audit's C3 pass to actually re-judge
 * the restated sentence rather than reusing the stale `"partial"`/
 * `"unsupported"` verdict from before the rewrite.
 */

import type { Chapter, ChapterSlug, VolumeSlug, VolumeStore } from "@shadow/core";
import {
  type AuditVerdict,
  type CheckOutcome,
  type CheckWorthinessClassifier,
  type ClaimRestater,
  type ClaimSidecar,
  type EntailmentRelevanceJudge,
  type EvidenceStore,
  isRepairable,
  type RepairDecision,
  runFullAudit,
  runRepairLoop,
  toLedgerEvent,
} from "@shadow/evidence";
import type { Indexer } from "@shadow/indexing";
import { ChapterHasNoClaimsError } from "./errors.ts";

export interface PublishDeps {
  readonly volumeStore: VolumeStore;
  readonly evidenceStore: EvidenceStore;
  readonly indexer: Indexer;
  readonly checkWorthinessClassifier: CheckWorthinessClassifier;
  readonly entailmentRelevanceJudge: EntailmentRelevanceJudge;
  readonly claimRestater: ClaimRestater;
}

export interface PublishResult {
  readonly volume: VolumeSlug;
  readonly chapter: ChapterSlug;
  readonly verdict: AuditVerdict;
  readonly outcomes: readonly CheckOutcome[];
  readonly repairs: readonly RepairDecision[];
  /** `true` iff the audit passed and the corpus was reindexed. */
  readonly published: boolean;
}

function coerceWhenToUse(frontmatter: Readonly<Record<string, unknown>>): string | undefined {
  const value = frontmatter.when_to_use;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** `#blocking checks passed / #blocking checks` — a coarse, cheap proxy for `docs/EVIDENCE.md`'s "claim completeness rate" metric, good enough for the ledger's informational `audit.completed` event (not a gate; the gate is `verdict.passed`). */
function completenessOf(outcomes: readonly CheckOutcome[]): number {
  const blocking = outcomes.filter((outcome) => outcome.blocking);
  if (blocking.length === 0) return 1;
  return blocking.filter((outcome) => outcome.passed).length / blocking.length;
}

async function runAudit(
  deps: PublishDeps,
  volume: VolumeSlug,
  chapter: Chapter,
  sidecar: ClaimSidecar,
  chapterSubject: string,
  whenToUse: string | undefined,
) {
  const [lookup, retiredLabels] = await Promise.all([
    deps.evidenceStore.loadLookupFor(volume, sidecar),
    deps.evidenceStore.getRetiredLabels(volume, chapter.slug),
  ]);
  return runFullAudit({
    chapterBody: chapter.body,
    sidecar,
    lookup,
    retiredLabels,
    chapterSubject,
    whenToUse,
    checkWorthinessClassifier: deps.checkWorthinessClassifier,
    entailmentRelevanceJudge: deps.entailmentRelevanceJudge,
  });
}

/**
 * Apply every `"applied"` repair decision to `sidecar`'s claims and
 * `chapter`'s body text. `"escalated"` decisions are deliberately left
 * untouched here (D21: the bound rejects the restatement outright) — they
 * are still logged (by the caller, via `toLedgerEvent`) so the operator
 * sees the escalation, but the claim's text stands as the operator/model
 * wrote it, pending their own review.
 */
function applyRepairs(
  chapter: Chapter,
  sidecar: ClaimSidecar,
  decisions: readonly RepairDecision[],
): { readonly body: string; readonly sidecar: ClaimSidecar } {
  let body = chapter.body;
  const byClaimId = new Map(decisions.map((decision) => [decision.claimId, decision] as const));

  const claims = sidecar.claims.map((claim) => {
    const decision = byClaimId.get(claim.id);
    if (!decision || decision.outcome !== "applied") return claim;
    // `claim.text` is what `applyPreservationBound` restated against — the
    // sentence as the operator reads it in the chapter body, so a literal
    // substring replace keeps the two in lockstep.
    if (body.includes(decision.from)) {
      body = body.replace(decision.from, decision.to);
    }
    return { ...claim, text: decision.to, decontextualized: decision.to };
  });

  return { body, sidecar: { ...sidecar, claims } };
}

/**
 * Run the CoE audit over an already-drafted chapter (`chapter-draft.ts`),
 * repair what is repairable, persist the result, and — only on a passing
 * verdict — reindex the corpus. A failing chapter's file and sidecar are
 * left on disk exactly as repair left them: visible to the operator (D9/
 * D21 — thin evidence is surfaced, never hidden), just not reindexed, so it
 * is not yet reachable through `@shadow/cli`.
 *
 * @throws {ChapterHasNoClaimsError} if `chapter` has never been drafted.
 */
export async function publishChapter(
  deps: PublishDeps,
  volume: VolumeSlug,
  chapter: ChapterSlug,
): Promise<PublishResult> {
  const [chapterDoc, sidecar] = await Promise.all([
    deps.volumeStore.getChapter(volume, chapter),
    deps.evidenceStore.getClaims(volume, chapter),
  ]);
  if (!sidecar) {
    throw new ChapterHasNoClaimsError(volume, chapter);
  }

  const chapterSubject = chapterDoc.title;
  const whenToUse = coerceWhenToUse(chapterDoc.frontmatter);

  let result = await runAudit(deps, volume, chapterDoc, sidecar, chapterSubject, whenToUse);
  const repairs: RepairDecision[] = [];

  // Repair triggers on *any* repairable claim, not on `!verdict.passed` —
  // `partial`/`conflicted` do not block the verdict (`docs/EVIDENCE.md`:
  // "a chapter passes iff ... C3 has zero unsupported"), but D9's repair
  // table still restates them ("route to restatement" applies to all three
  // repairable statuses, only `unsupported` also gates publication).
  const repairable = result.sidecar.claims.filter((claim) =>
    isRepairable(claim.verification.status),
  );
  if (repairable.length > 0) {
    const decisions = await runRepairLoop(
      result.sidecar.claims,
      deps.claimRestater,
      (claim) => claim.evidence.map((span) => span.selector.exact),
      chapter,
    );
    repairs.push(...decisions);
    for (const decision of decisions) {
      await deps.evidenceStore.appendLedgerEvent(volume, toLedgerEvent(decision));
    }

    const applied = applyRepairs(chapterDoc, result.sidecar, decisions);
    let repairedChapter = chapterDoc;
    if (applied.body !== chapterDoc.body) {
      repairedChapter = await deps.volumeStore.putChapter(volume, {
        slug: chapter,
        title: chapterDoc.title,
        body: applied.body,
        frontmatter: chapterDoc.frontmatter,
      });
    }
    await deps.evidenceStore.putClaims(volume, applied.sidecar);

    result = await runAudit(
      deps,
      volume,
      repairedChapter,
      applied.sidecar,
      chapterSubject,
      whenToUse,
    );
  }

  await deps.evidenceStore.putClaims(volume, result.sidecar);
  await deps.evidenceStore.putAudit(volume, chapter, result.record);
  await deps.evidenceStore.appendLedgerEvent(volume, {
    ts: new Date().toISOString(),
    event: "audit.completed",
    chapter,
    result: result.verdict.passed ? "pass" : "fail",
    completeness: completenessOf(result.outcomes),
    narrativeRatio: result.sidecar.narrative?.ratio ?? 0,
  });

  let published = false;
  if (result.verdict.passed) {
    await deps.indexer.reindex(deps.volumeStore);
    published = true;
  }

  return {
    volume,
    chapter,
    verdict: result.verdict,
    outcomes: result.outcomes,
    repairs,
    published,
  };
}
