/**
 * The audit gate for one rule-book group — the rule-book counterpart of
 * `@shadow/agent`'s `publishChapter` (`packages/agent/src/publish.ts`),
 * mirrored deliberately close: same audit → repair-if-repairable → re-audit
 * once → persist → flip-to-stable-on-pass shape, just against
 * `RulebookStore`/group vocabulary instead of `VolumeStore`/chapter.
 *
 * **No reindexing.** `publishChapter`'s last step on a passing verdict is
 * `deps.indexer.reindex(...)`; this module has no `indexer` dependency at
 * all. Corpus-index integration of rule books is deferred — a published
 * group is durable on disk (`status: "stable"`, `verified` appended) but not
 * yet reachable through `shadow find` or any retrieval index.
 *
 * **C4 (index alignment) never runs here either**, for the same reason
 * `publishChapter`'s first-publish path omits it: `runFullAudit`'s
 * `indexNodeSummaries` is simply never passed, so C4 is skipped entirely
 * rather than run against nothing.
 */

import type { Chapter, ChapterSlug, RulebookStore, VolumeSlug } from "@shadow/core";
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
import { GroupHasNoClaimsError } from "./errors.ts";

export interface PublishGroupDeps {
  readonly rulebookStore: RulebookStore;
  readonly evidenceStore: EvidenceStore;
  readonly checkWorthinessClassifier: CheckWorthinessClassifier;
  readonly entailmentRelevanceJudge: EntailmentRelevanceJudge;
  readonly claimRestater: ClaimRestater;
}

export interface PublishGroupResult {
  readonly rulebookSlug: VolumeSlug;
  readonly groupSlug: ChapterSlug;
  readonly verdict: AuditVerdict;
  readonly outcomes: readonly CheckOutcome[];
  readonly repairs: readonly RepairDecision[];
  /** `true` iff the audit passed and the group was flipped to `"stable"`. */
  readonly passed: boolean;
}

function coerceWhenToUse(frontmatter: Readonly<Record<string, unknown>>): string | undefined {
  const value = frontmatter.when_to_use;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** `#blocking checks passed / #blocking checks` — same coarse completeness proxy `publishChapter` logs on `audit.completed`. */
function completenessOf(outcomes: readonly CheckOutcome[]): number {
  const blocking = outcomes.filter((outcome) => outcome.blocking);
  if (blocking.length === 0) return 1;
  return blocking.filter((outcome) => outcome.passed).length / blocking.length;
}

/**
 * Labels genuinely retired: present in `getRetiredLabels`'s history but
 * *not* in the sidecar being audited right now. Labels are content-derived
 * (`ruleLabel`, `@shadow/rulebook`'s `labels.ts`) and `getRetiredLabels`
 * never forgets a label once it's left a sidecar once — so a rule that
 * left a group in one run and was re-derived (unchanged content) in a
 * later run would otherwise fail C1a forever with no repair path.
 * A label the *current* sidecar legitimately re-derived for its current
 * content is not a reuse violation; a label genuinely absent from the
 * current sidecar stays guarded.
 */
function subtractCurrentLabels(
  retiredLabels: ReadonlySet<string>,
  sidecar: ClaimSidecar,
): ReadonlySet<string> {
  const currentLabels = new Set(sidecar.claims.map((claim) => claim.label));
  return new Set([...retiredLabels].filter((label) => !currentLabels.has(label)));
}

async function runAudit(
  deps: PublishGroupDeps,
  rulebookSlug: VolumeSlug,
  group: Chapter,
  sidecar: ClaimSidecar,
  groupSubject: string,
  whenToUse: string | undefined,
  rawRetiredLabels: ReadonlySet<string>,
) {
  const lookup = await deps.evidenceStore.loadLookupFor(rulebookSlug, sidecar);
  const retiredLabels = subtractCurrentLabels(rawRetiredLabels, sidecar);
  return runFullAudit({
    chapterBody: group.body,
    sidecar,
    lookup,
    retiredLabels,
    chapterSubject: groupSubject,
    whenToUse,
    checkWorthinessClassifier: deps.checkWorthinessClassifier,
    entailmentRelevanceJudge: deps.entailmentRelevanceJudge,
  });
}

/** Apply every `"applied"` repair decision to `sidecar`'s claims and `group`'s body text. Identical shape to `publishChapter`'s `applyRepairs` — duplicated rather than shared, since this package deliberately does not depend on `@shadow/agent`. */
function applyRepairs(
  group: Chapter,
  sidecar: ClaimSidecar,
  decisions: readonly RepairDecision[],
): { readonly body: string; readonly sidecar: ClaimSidecar } {
  let body = group.body;
  const byClaimId = new Map(decisions.map((decision) => [decision.claimId, decision] as const));

  const claims = sidecar.claims.map((claim) => {
    const decision = byClaimId.get(claim.id);
    if (!decision || decision.outcome !== "applied") return claim;
    if (body.includes(decision.from)) {
      body = body.replace(decision.from, decision.to);
    }
    return { ...claim, text: decision.to, decontextualized: decision.to };
  });

  return { body, sidecar: { ...sidecar, claims } };
}

/**
 * Run the CoE audit over an already-assembled group (`assembly.ts`), repair
 * what's repairable, persist the result, and — only on a passing verdict —
 * flip the group's status to `"stable"` and append a `process:audit`
 * verification. See module doc for the two deliberate differences from
 * `publishChapter`: no reindex, no C4.
 *
 * `retiredLabels` is this group's slice of `EvidenceStore.getRetiredLabels`'s
 * history — the caller (`RulebookToolAgent`) reads the ledger once for the
 * whole run and passes each group its own labels, rather than every group's
 * publish re-reading the full ledger itself. That also keeps `publishGroup`
 * free of any whole-ledger read, which matters once groups publish
 * concurrently: per-group reads/writes stay independent, only the (already
 * atomic, append-only) ledger append is shared.
 *
 * @throws {GroupHasNoClaimsError} if `groupSlug` has never been assembled.
 */
export async function publishGroup(
  deps: PublishGroupDeps,
  rulebookSlug: VolumeSlug,
  groupSlug: ChapterSlug,
  retiredLabels: ReadonlySet<string>,
): Promise<PublishGroupResult> {
  const [groupDoc, sidecar] = await Promise.all([
    deps.rulebookStore.getGroup(rulebookSlug, groupSlug),
    deps.evidenceStore.getClaims(rulebookSlug, groupSlug),
  ]);
  if (!sidecar) {
    throw new GroupHasNoClaimsError(rulebookSlug, groupSlug);
  }

  const groupSubject = groupDoc.title;
  const whenToUse = coerceWhenToUse(groupDoc.frontmatter);

  let result = await runAudit(
    deps,
    rulebookSlug,
    groupDoc,
    sidecar,
    groupSubject,
    whenToUse,
    retiredLabels,
  );
  const repairs: RepairDecision[] = [];
  let currentGroup = groupDoc;

  // Repair triggers on *any* repairable claim, not `!verdict.passed` — see
  // `publishChapter`'s identical comment: partial/conflicted don't block
  // the verdict, but D9's repair table still restates them.
  const repairable = result.sidecar.claims.filter((claim) =>
    isRepairable(claim.verification.status),
  );
  if (repairable.length > 0) {
    const decisions = await runRepairLoop(
      result.sidecar.claims,
      deps.claimRestater,
      (claim) => claim.evidence.map((span) => span.selector.exact),
      groupSlug,
    );
    repairs.push(...decisions);
    for (const decision of decisions) {
      await deps.evidenceStore.appendLedgerEvent(rulebookSlug, toLedgerEvent(decision));
    }

    const applied = applyRepairs(groupDoc, result.sidecar, decisions);
    if (applied.body !== groupDoc.body) {
      currentGroup = await deps.rulebookStore.putGroup(rulebookSlug, {
        slug: groupSlug,
        title: groupDoc.title,
        body: applied.body,
        frontmatter: groupDoc.frontmatter,
      });
    }
    await deps.evidenceStore.putClaims(rulebookSlug, applied.sidecar);

    result = await runAudit(
      deps,
      rulebookSlug,
      currentGroup,
      applied.sidecar,
      groupSubject,
      whenToUse,
      retiredLabels,
    );
  }

  await deps.evidenceStore.putClaims(rulebookSlug, result.sidecar);
  await deps.evidenceStore.putAudit(rulebookSlug, groupSlug, result.record);
  await deps.evidenceStore.appendLedgerEvent(rulebookSlug, {
    ts: new Date().toISOString(),
    event: "audit.completed",
    chapter: groupSlug,
    result: result.verdict.passed ? "pass" : "fail",
    completeness: completenessOf(result.outcomes),
    narrativeRatio: result.sidecar.narrative?.ratio ?? 0,
  });

  let passed = false;
  if (result.verdict.passed) {
    await deps.rulebookStore.putGroup(rulebookSlug, {
      slug: groupSlug,
      title: currentGroup.title,
      body: currentGroup.body,
      type: currentGroup.type,
      status: "stable",
      generated: currentGroup.generated,
      verified: [...currentGroup.verified, { by: "process:audit", at: new Date() }],
      frontmatter: currentGroup.frontmatter,
    });
    passed = true;
  }

  return {
    rulebookSlug,
    groupSlug,
    verdict: result.verdict,
    outcomes: result.outcomes,
    repairs,
    passed,
  };
}
