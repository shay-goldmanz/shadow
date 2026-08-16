/**
 * Assembly: turns one final group's consolidated rules into a persisted
 * group document (`RulebookStore.putGroup`) and its claim sidecar
 * (`EvidenceStore.putClaims`) — the rule-book counterpart of
 * `@shadow/agent`'s `chapter-draft.ts`, minus the directive layer (a rule's
 * evidence is already validated, normalized quotes by the time it reaches
 * here, `validate.ts`/`merge.ts`).
 *
 * **The body is flat bullets, one rule per line** (`- <statement>[^<label>]`)
 * — deliberately no narrative prose. Every sentence in a group is a claim by
 * construction, so the C1b (check-worthiness) batch `runFullAudit` builds
 * for a group is always empty: there is no unmarked sentence to classify.
 *
 * **One `EvidenceSpan` per normalized quote**, bound via `@shadow/evidence`'s
 * `buildSpanFromQuote` against the rule book's single ingested source
 * (`sourceId` — one document ingested per rule-book run, by current design). A
 * quote that fails to bind here — `UnresolvedEvidenceQuoteError` — is
 * dropped and counted; this should be rare, since `validate.ts` already
 * checked the identical predicate (`normalizedSnapshotText.includes(...)`)
 * against the same snapshot. A rule whose *every* quote fails to bind is
 * dropped from both the body and the claim list entirely, and counted
 * separately.
 *
 * **Carry-over.** Before writing, the group's *previous* claim sidecar (if
 * any — a re-run over an unchanged or lightly-edited document) is loaded.
 * Every freshly-built claim starts `"unchecked"` (matching
 * `chapter-draft.ts`'s convention: unchecked is the one status Tier 2's
 * memoization always re-judges regardless of `inputHash`). For a claim whose
 * label existed before *and* whose freshly-computed `inputHash` is
 * unchanged from that previous claim's, the *entire* previous
 * `verification` (status, rationale, everything) is copied over wholesale
 * — this is what lets an unchanged rule skip re-judging on a re-run, since
 * Tier 2's own memoization diffs `inputHash` against `verification.inputHash`,
 * not against "was this freshly built."
 */

import {
  type Chapter,
  type ChapterInput,
  type RulebookStore,
  toChapterSlug,
  type VolumeSlug,
} from "@shadow/core";
import {
  buildSpanFromQuote,
  type Claim,
  type ClaimSidecar,
  computeInputHash,
  type EvidenceSpan,
  type EvidenceStore,
  newClaimId,
  sha256Of,
  UnresolvedEvidenceQuoteError,
} from "@shadow/evidence";
import type { ConsolidatedRule } from "./merge.ts";
import type { TaxonomyGroup } from "./schemas.ts";

export interface AssembleGroupDeps {
  readonly rulebookStore: RulebookStore;
  readonly evidenceStore: EvidenceStore;
}

export interface AssembleGroupArgs {
  readonly rulebookSlug: VolumeSlug;
  /** The rule book's one ingested document's witnessed source id (`IngestedDocument.sourceId`) — every rule's quotes bind against it. */
  readonly sourceId: string;
  /** This group's finalized plan metadata (slug/title/routing fields) — `finalize-groups.ts`'s output, one entry of `FinalizeGroupsResult.groups`. */
  readonly group: TaxonomyGroup;
  /** Rules `finalize-groups.ts` assigned to this group, in stable (consolidation) order. */
  readonly rules: readonly ConsolidatedRule[];
}

export interface AssembleGroupResult {
  readonly group: Chapter;
  readonly sidecar: ClaimSidecar;
  /** Individual quotes that failed to bind (dropped), across every rule in this group. */
  readonly droppedQuotes: number;
  /** Rules dropped entirely because every one of their quotes failed to bind. */
  readonly droppedRules: number;
}

interface BuiltClaim {
  readonly claim: Claim | undefined;
  readonly droppedQuotes: number;
}

async function buildClaimForRule(
  evidenceStore: EvidenceStore,
  rulebookSlug: VolumeSlug,
  sourceId: string,
  rule: ConsolidatedRule,
): Promise<BuiltClaim> {
  const evidence: EvidenceSpan[] = [];
  let droppedQuotes = 0;

  for (const quote of rule.normalizedQuotes) {
    try {
      evidence.push(
        await buildSpanFromQuote(evidenceStore, rulebookSlug, rule.label, { sourceId, quote }),
      );
    } catch (error) {
      if (!(error instanceof UnresolvedEvidenceQuoteError)) throw error;
      droppedQuotes += 1;
    }
  }

  if (evidence.length === 0) {
    return { claim: undefined, droppedQuotes };
  }

  const inputHash = computeInputHash({
    decontextualized: rule.statement,
    evidence: evidence.map((span) => ({
      exact: span.selector.exact,
      snapshotHash: span.snapshotHash,
    })),
    supports: [],
  });

  const claim: Claim = {
    id: newClaimId(),
    label: rule.label,
    kind: "sourced",
    text: rule.statement,
    decontextualized: rule.statement,
    checkRequired: true,
    evidence,
    supports: [],
    verification: { status: "unchecked", inputHash },
  };

  return { claim, droppedQuotes };
}

/** Copy a previous run's verification wholesale when the claim's inputHash is unchanged — see module doc's "Carry-over". */
function withCarriedOverVerification(
  claim: Claim,
  existingByLabel: ReadonlyMap<string, Claim>,
): Claim {
  const existing = existingByLabel.get(claim.label);
  if (existing && existing.verification.inputHash === claim.verification.inputHash) {
    return { ...claim, verification: existing.verification };
  }
  return claim;
}

function groupFrontmatter(group: TaxonomyGroup): Record<string, unknown> {
  return {
    when_to_use: group.when_to_use,
    not_for: group.not_for,
    keywords: [...group.keywords],
  };
}

/**
 * Assemble one final group: bind every rule's quotes to evidence spans,
 * build one `Claim` per surviving rule, carry over unchanged verifications
 * from the group's previous run (if any), and persist both the group
 * document and its claim sidecar. Always writes something — even a
 * pathological group where every rule's every quote fails to bind persists
 * an empty-body group with zero claims, rather than throwing; that group
 * will trivially pass its Chain-of-Evidence audit (nothing to fail).
 */
export async function assembleGroup(
  deps: AssembleGroupDeps,
  args: AssembleGroupArgs,
): Promise<AssembleGroupResult> {
  const groupSlug = toChapterSlug(args.group.slug);

  const existingSidecar = await deps.evidenceStore.getClaims(args.rulebookSlug, groupSlug);
  const existingByLabel = new Map(
    existingSidecar?.claims.map((claim) => [claim.label, claim] as const) ?? [],
  );

  const bodyLines: string[] = [];
  const claims: Claim[] = [];
  let droppedQuotes = 0;
  let droppedRules = 0;

  for (const rule of args.rules) {
    const built = await buildClaimForRule(
      deps.evidenceStore,
      args.rulebookSlug,
      args.sourceId,
      rule,
    );
    droppedQuotes += built.droppedQuotes;
    if (!built.claim) {
      droppedRules += 1;
      continue;
    }
    claims.push(withCarriedOverVerification(built.claim, existingByLabel));
    bodyLines.push(`- ${rule.statement}[^${rule.label}]`);
  }

  const body = bodyLines.join("\n");

  const group = await deps.rulebookStore.putGroup(args.rulebookSlug, {
    slug: groupSlug,
    title: args.group.title,
    body,
    type: "Rule Group",
    status: "draft",
    // Reset alongside `status` on every write — a stale `process:audit`
    // verification from a prior run attests to a body that no longer
    // exists once this group has been reassembled. `putGroup`'s
    // preserve-on-upsert would otherwise carry the old `verified` forward
    // since this field would be omitted.
    verified: [],
    generated: { by: "process:rulebook", at: new Date() },
    frontmatter: groupFrontmatter(args.group),
  } satisfies ChapterInput);

  const sidecar: ClaimSidecar = {
    schemaVersion: "1.0",
    chapter: groupSlug,
    chapterTextSha256: sha256Of(body),
    claims,
  };
  await deps.evidenceStore.putClaims(args.rulebookSlug, sidecar);

  return { group, sidecar, droppedQuotes, droppedRules };
}
