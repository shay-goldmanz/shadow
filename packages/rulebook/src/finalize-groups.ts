/**
 * The group-finalization call: one batched structured LLM call reconciling
 * every consolidated rule's chunk-proposed group against the taxonomy's
 * final group menu (`taxonomy.ts`'s `planTaxonomy` proposes the menu; each
 * chunk's extraction, `extraction.ts`'s `extractChunk`, proposes a group
 * per rule *without* seeing the other chunks' rules) — a document-wide
 * reconciliation pass a single chunk's extraction call structurally cannot
 * do.
 *
 * Everything past the one LLM call is pure, deterministic, client-side
 * bucketing:
 *
 * - A response naming a group slug outside the known menu falls back to
 *   `general` (never dropped — every rule must land somewhere).
 * - A label the response's `assignments[]` doesn't cover at all falls back
 *   to that rule's own chunk-proposed group (validated against the menu the
 *   same way).
 * - A group whose bucket exceeds `maxRulesPerGroup` (default
 *   {@link DEFAULT_MAX_RULES_PER_GROUP}) splits into `<slug>-2`, `<slug>-3`,
 *   ... in rule order — the first `maxRulesPerGroup` rules keep the
 *   original slug/title, each subsequent chunk gets a `-N`-suffixed slug and
 *   a `(N)`-suffixed title, both inheriting every other field from the
 *   parent plan.
 * - A group with zero rules assigned to it (its bucket is empty) is dropped
 *   from the final group list entirely — nothing downstream (`assembly.ts`)
 *   ever sees an empty group.
 */

import type { StructuredGenerationPort, TokenUsage } from "@shadow/model";
import { ZERO_USAGE } from "@shadow/model";
import { GENERAL_GROUP_SLUG } from "./taxonomy.ts";
import type { ConsolidatedRule } from "./merge.ts";
import { groupFinalizationSchema, type TaxonomyGroup } from "./schemas.ts";

/** Groups larger than this split client-side into `<slug>-2`, `-3`, ... */
export const DEFAULT_MAX_RULES_PER_GROUP = 40;

export interface FinalizeGroupsDeps {
  readonly structuredGeneration: StructuredGenerationPort;
}

export interface FinalizeGroupsArgs {
  /** Every consolidated rule (post-merge, labeled) needing a final group assignment. */
  readonly rules: readonly ConsolidatedRule[];
  /** The taxonomy's final group menu (`planTaxonomy`'s output, `general` included). */
  readonly groups: readonly TaxonomyGroup[];
  /** Default {@link DEFAULT_MAX_RULES_PER_GROUP}. */
  readonly maxRulesPerGroup?: number;
}

export interface FinalizeGroupsResult {
  /** Every rule's label mapped to its final (possibly `-N`-suffixed) group slug. */
  readonly assignments: ReadonlyMap<string, string>;
  /** The final group list — only groups with at least one assigned rule, in menu order, splits inserted immediately after their parent. */
  readonly groups: readonly TaxonomyGroup[];
  readonly usage: TokenUsage;
}

function groupMenuText(groups: readonly TaxonomyGroup[]): string {
  return groups.map((group) => `- ${group.slug}: ${group.title} — ${group.when_to_use}`).join("\n");
}

function ruleListText(rules: readonly ConsolidatedRule[]): string {
  return rules
    .map((rule) => `- [${rule.label}] (chunk proposed: ${rule.proposedGroup}) ${rule.statement}`)
    .join("\n");
}

/**
 * Reconcile every rule's chunk-proposed group against the taxonomy's final
 * menu with one batched structured call (`schemaName:
 * "rulebook-group-finalization"`), then deterministically bucket, split, and
 * drop groups client-side. Short-circuits (no call at all) when `rules` is
 * empty — the degenerate "nothing survived extraction/validation" path.
 */
export async function finalizeGroups(
  deps: FinalizeGroupsDeps,
  args: FinalizeGroupsArgs,
): Promise<FinalizeGroupsResult> {
  if (args.rules.length === 0) {
    return { assignments: new Map(), groups: [], usage: ZERO_USAGE };
  }

  const knownSlugs = new Set(args.groups.map((group) => group.slug));

  const system =
    "You are finalizing which group each already-extracted rule belongs to, given the rule " +
    "book's final group taxonomy. Each rule already has a chunk-level proposed group, made " +
    "without visibility into the rest of the document — reconcile it against the full menu " +
    'below. Assign every rule\'s label to exactly one group slug from the menu; use "general" ' +
    "only when a rule truly fits nowhere more specific.";

  const prompt = `Group menu:\n${groupMenuText(args.groups)}\n\nRules:\n${ruleListText(args.rules)}`;

  const result = await deps.structuredGeneration.generate({
    schema: groupFinalizationSchema,
    prompt,
    system,
    schemaName: "rulebook-group-finalization",
  });

  const responseByLabel = new Map(
    result.object.assignments.map((assignment) => [assignment.label, assignment.group] as const),
  );

  function resolveGroupSlug(rule: ConsolidatedRule): string {
    const proposed = responseByLabel.get(rule.label) ?? rule.proposedGroup;
    return knownSlugs.has(proposed) ? proposed : GENERAL_GROUP_SLUG;
  }

  const labelsByGroup = new Map<string, string[]>();
  for (const rule of args.rules) {
    const slug = resolveGroupSlug(rule);
    const bucket = labelsByGroup.get(slug);
    if (bucket) {
      bucket.push(rule.label);
    } else {
      labelsByGroup.set(slug, [rule.label]);
    }
  }

  const maxRulesPerGroup = args.maxRulesPerGroup ?? DEFAULT_MAX_RULES_PER_GROUP;
  const assignments = new Map<string, string>();
  const finalGroups: TaxonomyGroup[] = [];

  for (const group of args.groups) {
    const labels = labelsByGroup.get(group.slug);
    if (!labels || labels.length === 0) continue; // empty groups dropped

    if (labels.length <= maxRulesPerGroup) {
      finalGroups.push(group);
      for (const label of labels) assignments.set(label, group.slug);
      continue;
    }

    for (let start = 0, splitIndex = 1; start < labels.length; start += maxRulesPerGroup, splitIndex++) {
      const chunkLabels = labels.slice(start, start + maxRulesPerGroup);
      const isFirstSplit = splitIndex === 1;
      const splitSlug = isFirstSplit ? group.slug : `${group.slug}-${splitIndex}`;
      const splitTitle = isFirstSplit ? group.title : `${group.title} (${splitIndex})`;
      finalGroups.push({ ...group, slug: splitSlug, title: splitTitle });
      for (const label of chunkLabels) assignments.set(label, splitSlug);
    }
  }

  return { assignments, groups: finalGroups, usage: result.usage };
}
