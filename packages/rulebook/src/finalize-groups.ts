/**
 * The group-finalization call: batched structured LLM calls reconciling
 * every consolidated rule's chunk-proposed group against the taxonomy's
 * final group menu (`taxonomy.ts`'s `planTaxonomy` proposes the menu; each
 * chunk's extraction, `extraction.ts`'s `extractChunk`, proposes a group
 * per rule *without* seeing the other chunks' rules) — a document-wide
 * reconciliation pass a single chunk's extraction call structurally cannot
 * do.
 *
 * **Batched, not one giant call.** Every LLM decision here is per-rule
 * against the group menu (the system prompt frames it as per-label
 * assignment; `resolveGroupSlug` below looks only at that rule's own
 * response entry, falling back to its own chunk proposal) — nothing a rule
 * decides depends on any *other* rule's decision. That makes splitting the
 * rule list into batches of {@link FINALIZE_BATCH_SIZE} semantically
 * neutral: each batch's prompt carries the *same* full group menu plus only
 * that batch's rules, and batches run concurrently
 * (`stream-concurrency.ts`'s `streamWithConcurrency`, bounded by
 * `FinalizeGroupsArgs.concurrency`). **Every batch's `assignments` is
 * concatenated into one `responseByLabel` map before any bucketing
 * happens** — the client-side bucket/drop pass below runs exactly once,
 * globally, over the merged responses.
 *
 * **Memoized per batch**, mirroring `extraction.ts`'s pattern: keyed off a
 * hash of the group menu, a hash of that batch's rules, and the effective
 * model (`args.model ?? "default"`), so a taxonomy replan (different
 * menu), a different rule set (different batch contents), or a different
 * model (`port.ts`'s `RulebookBrief.finalizeModel` — a different model can
 * produce different assignments for byte-identical input) invalidates the
 * cache, while a re-run with the same document, menu, and model skips
 * every batch's LLM call entirely.
 *
 * Everything past the merged LLM responses is pure, deterministic,
 * client-side bucketing:
 *
 * - A response naming a group slug outside the known menu falls back to
 *   `general` (never dropped — every rule must land somewhere).
 * - A label the merged responses don't cover at all falls back to that
 *   rule's own chunk-proposed group (validated against the menu the same
 *   way).
 * - A group with zero rules assigned to it (its bucket is empty) is dropped
 *   from the final group list entirely — nothing downstream (`assembly.ts`)
 *   ever sees an empty group. There is no cap on how many rules a single
 *   group can carry (the prior 40-rule split was removed) — a group's
 *   bucket, however large, stays one group and drives one audit batch
 *   downstream, i.e. one C3/C5 judge call over every claim in that group.
 */

import type { RulebookStore, VolumeSlug } from "@shadow/core";
import { addUsage, type StructuredGenerationPort, type TokenUsage, ZERO_USAGE } from "@shadow/model";
import { GENERAL_GROUP_SLUG } from "./taxonomy.ts";
import type { ConsolidatedRule } from "./merge.ts";
import { type GroupAssignment, groupFinalizationSchema, type TaxonomyGroup } from "./schemas.ts";
import { streamWithConcurrency } from "./stream-concurrency.ts";

/** Bump on a meaningful prompt/instruction change — invalidates every cached batch's assignments. */
export const FINALIZE_PROMPT_VERSION = "v1";

/** Rules per batched finalization call. Each batch's prompt still carries the full group menu. */
export const FINALIZE_BATCH_SIZE = 120;

const DEFAULT_FINALIZE_CONCURRENCY = 6;

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export interface FinalizeGroupsDeps {
  readonly structuredGeneration: StructuredGenerationPort;
  readonly rulebookStore: RulebookStore;
}

export interface FinalizeGroupsArgs {
  readonly rulebookSlug: VolumeSlug;
  /** Every consolidated rule (post-merge, labeled) needing a final group assignment. */
  readonly rules: readonly ConsolidatedRule[];
  /** The taxonomy's final group menu (`planTaxonomy`'s output, `general` included). */
  readonly groups: readonly TaxonomyGroup[];
  /** Caps in-flight batch calls (see `stream-concurrency.ts`'s `streamWithConcurrency`). Default 6. */
  readonly concurrency?: number;
  /** Test-only override of {@link FINALIZE_BATCH_SIZE} — lets tests compare a multi-batch run against a single-batch run over the byte-identical input to prove batch-boundary neutrality. Production callers should not set this. */
  readonly batchSize?: number;
  /** Forwarded as `StructuredGenerationRequest.model`; undefined leaves the adapter's own default in place (see `port.ts`'s `RulebookBrief.finalizeModel`). Folded into every batch's cache key. */
  readonly model?: string;
}

export interface FinalizeGroupsResult {
  /** Every rule's label mapped to its final group slug. */
  readonly assignments: ReadonlyMap<string, string>;
  /** The final group list — only groups with at least one assigned rule, in menu order. */
  readonly groups: readonly TaxonomyGroup[];
  readonly usage: TokenUsage;
  /** Batches served from the cache rather than a fresh LLM call. */
  readonly cachedBatches: number;
  readonly totalBatches: number;
}

function groupMenuText(groups: readonly TaxonomyGroup[]): string {
  return groups.map((group) => `- ${group.slug}: ${group.title} — ${group.when_to_use}`).join("\n");
}

function ruleListText(rules: readonly ConsolidatedRule[]): string {
  return rules
    .map((rule) => `- [${rule.label}] (chunk proposed: ${rule.proposedGroup}) ${rule.statement}`)
    .join("\n");
}

/** Cache-key basis for a batch's rules — deliberately narrower than the prompt text (no chunk-proposed group), since the group menu is hashed separately and folded in alongside this. */
function batchRulesHashText(rules: readonly ConsolidatedRule[]): string {
  return rules.map((rule) => `[${rule.label}] ${rule.statement}`).join("\n");
}

function finalizeCacheKey(
  promptVersion: string,
  menuHash: string,
  batchRulesHash: string,
  modelKey: string,
): string {
  return `final-${sha256Hex(`${promptVersion}${menuHash}${batchRulesHash}${modelKey}`).slice(0, 24)}`;
}

function batchRules(rules: readonly ConsolidatedRule[], batchSize: number): ConsolidatedRule[][] {
  const batches: ConsolidatedRule[][] = [];
  for (let start = 0; start < rules.length; start += batchSize) {
    batches.push(rules.slice(start, start + batchSize));
  }
  return batches;
}

interface BatchOutcome {
  readonly assignments: readonly GroupAssignment[];
  readonly cached: boolean;
  readonly usage: TokenUsage;
}

const SYSTEM_PROMPT =
  "You are finalizing which group each already-extracted rule belongs to, given the rule " +
  "book's final group taxonomy. Each rule already has a chunk-level proposed group, made " +
  "without visibility into the rest of the document — reconcile it against the full menu " +
  'below. Assign every rule\'s label to exactly one group slug from the menu; use "general" ' +
  "only when a rule truly fits nowhere more specific.";

/**
 * Finalize one batch: a cache hit returns its stored assignments with zero
 * usage; a miss drives one structured call (`schemaName:
 * "rulebook-group-finalization"`) over just this batch's rules against the
 * full menu, then writes the raw assignments back to the cache.
 */
async function finalizeBatch(
  deps: FinalizeGroupsDeps,
  args: {
    readonly rulebookSlug: VolumeSlug;
    readonly batch: readonly ConsolidatedRule[];
    readonly menuText: string;
    readonly menuHash: string;
    readonly model?: string;
  },
): Promise<BatchOutcome> {
  const batchRulesHash = sha256Hex(batchRulesHashText(args.batch));
  const modelKey = args.model ?? "default";
  const key = finalizeCacheKey(FINALIZE_PROMPT_VERSION, args.menuHash, batchRulesHash, modelKey);

  const rawCached = await deps.rulebookStore.readExtractionCache<unknown>(args.rulebookSlug, key);
  if (rawCached) {
    // Parse failure (a hand-edited or corrupted cache file) is a cache
    // miss, not a crash — self-healing, same as extraction.ts's own cache read.
    const parsed = groupFinalizationSchema.safeParse(rawCached);
    if (parsed.success) {
      return { assignments: parsed.data.assignments, cached: true, usage: ZERO_USAGE };
    }
  }

  const prompt = `Group menu:\n${args.menuText}\n\nRules:\n${ruleListText(args.batch)}`;

  const result = await deps.structuredGeneration.generate({
    schema: groupFinalizationSchema,
    prompt,
    system: SYSTEM_PROMPT,
    schemaName: "rulebook-group-finalization",
    model: args.model,
  });

  await deps.rulebookStore.writeExtractionCache(args.rulebookSlug, key, result.object);

  return { assignments: result.object.assignments, cached: false, usage: result.usage };
}

/**
 * Reconcile every rule's chunk-proposed group against the taxonomy's final
 * menu with batched, parallel, memoized structured calls (one per batch of
 * up to {@link FINALIZE_BATCH_SIZE} rules — see module doc for why batching
 * is semantically neutral), then deterministically bucket and drop groups
 * client-side exactly once over the merged responses. Short-circuits (no
 * call at all) when `rules` is empty — the degenerate "nothing survived
 * extraction/validation" path.
 */
export async function finalizeGroups(
  deps: FinalizeGroupsDeps,
  args: FinalizeGroupsArgs,
): Promise<FinalizeGroupsResult> {
  if (args.rules.length === 0) {
    return { assignments: new Map(), groups: [], usage: ZERO_USAGE, cachedBatches: 0, totalBatches: 0 };
  }

  // Sort by label before batching. `args.rules`' incoming order follows
  // chunk-extraction COMPLETION order (`consolidateRules` preserves
  // first-seen order over whatever `streamWithConcurrency` handed it), which
  // is nondeterministic even on an otherwise byte-identical, fully-cached
  // re-run. That instability propagated into each batch's `batchRulesHash`
  // (this file's cache key): it depended on which rules happened to land in
  // it, so a warm re-run's arrival order could shuffle rules between batches
  // and miss a cache that should have hit. Sorting once here, up front,
  // makes batch membership — and so the cache key — a pure function of the
  // rule set, not of arrival order.
  const rules = [...args.rules].sort((a, b) => a.label.localeCompare(b.label));

  const knownSlugs = new Set(args.groups.map((group) => group.slug));
  const menuText = groupMenuText(args.groups);
  const menuHash = sha256Hex(menuText);

  const batches = batchRules(rules, args.batchSize ?? FINALIZE_BATCH_SIZE);
  const concurrency = args.concurrency ?? DEFAULT_FINALIZE_CONCURRENCY;

  let usage = ZERO_USAGE;
  let cachedBatches = 0;
  // Every batch's assignments land in this one map BEFORE any bucketing
  // runs (see module doc) — batch order doesn't matter since batches
  // partition disjoint rule labels.
  const responseByLabel = new Map<string, string>();

  for await (const outcome of streamWithConcurrency(batches, concurrency, (batch) =>
    finalizeBatch(deps, { rulebookSlug: args.rulebookSlug, batch, menuText, menuHash, model: args.model }),
  )) {
    usage = addUsage(usage, outcome.usage);
    if (outcome.cached) cachedBatches += 1;
    for (const assignment of outcome.assignments) {
      responseByLabel.set(assignment.label, assignment.group);
    }
  }

  function resolveGroupSlug(rule: ConsolidatedRule): string {
    const proposed = responseByLabel.get(rule.label) ?? rule.proposedGroup;
    return knownSlugs.has(proposed) ? proposed : GENERAL_GROUP_SLUG;
  }

  const labelsByGroup = new Map<string, string[]>();
  for (const rule of rules) {
    const slug = resolveGroupSlug(rule);
    const bucket = labelsByGroup.get(slug);
    if (bucket) {
      bucket.push(rule.label);
    } else {
      labelsByGroup.set(slug, [rule.label]);
    }
  }

  const assignments = new Map<string, string>();
  const finalGroups: TaxonomyGroup[] = [];

  for (const group of args.groups) {
    const labels = labelsByGroup.get(group.slug);
    if (!labels || labels.length === 0) continue; // empty groups dropped

    finalGroups.push(group);
    for (const label of labels) assignments.set(label, group.slug);
  }

  return { assignments, groups: finalGroups, usage, cachedBatches, totalBatches: batches.length };
}
