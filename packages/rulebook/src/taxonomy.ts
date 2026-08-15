/**
 * The taxonomy call: one structured LLM call proposing the rule book's
 * group structure — chapter-shaped documents (`@shadow/core`'s
 * `RulebookStore`) the per-chunk extraction pass will file rules into. The
 * prompt is built from the chunked document's outline (each chunk's
 * heading path plus its opening ~200 chars) rather than the full text — a
 * taxonomy call reasons about the document's *shape*, not its content in
 * full — and is capped to keep the call cheap and reliable.
 *
 * Cached per document snapshot via `RulebookStore`'s extraction cache — but
 * the cache key also folds in `scope`/`constraints`/`maxGroups` and
 * {@link TAXONOMY_PROMPT_VERSION}: the same document re-run with a
 * different scope or constraint must not silently return a stale plan that
 * ignored them, and a prompt/instruction change needs a manual escape
 * hatch to invalidate every cached plan even when nothing else changed
 * (mirrors `extraction.ts`'s `PROMPT_VERSION`).
 */

import type { RulebookStore, VolumeSlug } from "@shadow/core";
import type { StructuredGenerationPort, TokenUsage } from "@shadow/model";
import { ZERO_USAGE } from "@shadow/model";
import { z } from "zod";
import type { DocumentChunk } from "./chunker.ts";
import { DEFAULT_MAX_GROUPS, taxonomyGroupSchema, taxonomySchema, type TaxonomyGroup } from "./schemas.ts";

/** Bump on a meaningful prompt/instruction change — invalidates every cached taxonomy plan. */
export const TAXONOMY_PROMPT_VERSION = "v1";

/** How much of each chunk's opening text is folded into the outline the taxonomy call sees. */
const CHUNK_PREVIEW_CHARS = 200;

/** Overall outline budget — ~8k tokens at the chunker's 4-chars/token estimate. */
const MAX_OUTLINE_CHARS = 32_000;

/** Reserved catch-all group, appended client-side if the LLM didn't already propose one. */
export const GENERAL_GROUP_SLUG = "general";

function generalGroup(): TaxonomyGroup {
  return {
    slug: GENERAL_GROUP_SLUG,
    title: "General",
    when_to_use: "A rule that doesn't clearly belong to any other group in this rule book.",
    not_for: "Any rule that fits a more specific group — file it there instead.",
    keywords: [],
  };
}

function appendGeneralGroup(groups: readonly TaxonomyGroup[]): TaxonomyGroup[] {
  if (groups.some((group) => group.slug === GENERAL_GROUP_SLUG)) return [...groups];
  return [...groups, generalGroup()];
}

function outlineLine(chunk: DocumentChunk): string {
  const heading = chunk.headingPath.length > 0 ? chunk.headingPath.join(" > ") : "(no heading)";
  const preview = chunk.text.slice(0, CHUNK_PREVIEW_CHARS).replace(/\s+/g, " ").trim();
  return `[chunk ${chunk.index}] ${heading}\n${preview}`;
}

/**
 * Fit the document's outline under `maxChars`. If the full outline is too
 * big, evenly downsample the chunk list (rather than just truncating the
 * tail) so the taxonomy call still sees structure from across the whole
 * document, not only its opening chunks — and note the truncation inline
 * so the model knows the outline is partial.
 */
function fitOutline(chunks: readonly DocumentChunk[], maxChars: number): string {
  const lines = chunks.map(outlineLine);
  const full = lines.join("\n\n");
  if (full.length <= maxChars) return full;

  let kept = lines;
  let stride = 1;
  while (kept.join("\n\n").length > maxChars && kept.length > 1) {
    stride += 1;
    kept = lines.filter((_, index) => index % stride === 0);
  }

  const notice = `[note: document outline truncated to fit the prompt budget — showing ${kept.length} of ${lines.length} chunks, evenly sampled across the document]`;
  return `${notice}\n\n${kept.join("\n\n")}`;
}

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/**
 * `plan-<24 hex>` — hashes the prompt version, the document's snapshot
 * hash, and every brief field that changes what the taxonomy call actually
 * asks for (`scope`/`constraints`/`maxGroups`). Any one of these differing
 * between two calls must be a cache miss; folding all of them into the key
 * (rather than snapshot hash alone) is what guarantees that.
 */
function taxonomyCacheKey(
  promptVersion: string,
  snapshotSha256: string,
  scope: string | undefined,
  constraints: readonly string[] | undefined,
  maxGroups: number,
): string {
  const basis = [
    promptVersion,
    snapshotSha256,
    scope ?? "",
    (constraints ?? []).join("|"),
    String(maxGroups),
  ].join(" ");
  return `plan-${sha256Hex(basis).slice(0, 24)}`;
}

/** Cache-read schema — no `maxGroups` cap (a cached plan may have been written under a different, looser cap than the current call's). Parse failure is treated as a cache miss (self-healing) rather than a crash. */
const cachedTaxonomySchema = z.object({ groups: z.array(taxonomyGroupSchema) });

export interface PlanTaxonomyDeps {
  readonly structuredGeneration: StructuredGenerationPort;
  readonly rulebookStore: RulebookStore;
}

export interface PlanTaxonomyArgs {
  readonly rulebookSlug: VolumeSlug;
  readonly chunks: readonly DocumentChunk[];
  /** The ingested document's snapshot hash (`IngestedDocument.snapshotSha256`) — the cache key's basis. */
  readonly snapshotSha256: string;
  /** Free-text steer for the taxonomy call, e.g. "focus on borrower obligations, not lender remedies". */
  readonly scope?: string;
  readonly constraints?: readonly string[];
  /** Caps the number of proposed groups (before the reserved `general` group is appended). Default {@link DEFAULT_MAX_GROUPS}. */
  readonly maxGroups?: number;
}

export interface PlanTaxonomyResult {
  /** The LLM's proposed groups plus the reserved `general` group. */
  readonly groups: readonly TaxonomyGroup[];
  readonly cached: boolean;
  readonly usage: TokenUsage;
}

/**
 * Plan a rule book's group taxonomy from its chunked outline. One
 * structured call (`schemaName: "rulebook-taxonomy"`) on a cache miss;
 * memoized on `rulebookStore`'s extraction cache, keyed by document
 * snapshot hash *and* every brief field that changes the taxonomy call's
 * prompt (`scope`/`constraints`/`maxGroups`).
 */
export async function planTaxonomy(
  deps: PlanTaxonomyDeps,
  args: PlanTaxonomyArgs,
): Promise<PlanTaxonomyResult> {
  const maxGroups = args.maxGroups ?? DEFAULT_MAX_GROUPS;
  const key = taxonomyCacheKey(
    TAXONOMY_PROMPT_VERSION,
    args.snapshotSha256,
    args.scope,
    args.constraints,
    maxGroups,
  );

  const rawCached = await deps.rulebookStore.readExtractionCache<unknown>(args.rulebookSlug, key);
  if (rawCached) {
    // Parse failure (a hand-edited or corrupted cache file) is a cache
    // miss, not a crash — self-healing.
    const parsed = cachedTaxonomySchema.safeParse(rawCached);
    if (parsed.success) {
      return { groups: appendGeneralGroup(parsed.data.groups), cached: true, usage: ZERO_USAGE };
    }
  }

  const outline = fitOutline(args.chunks, MAX_OUTLINE_CHARS);
  const scopeLine = args.scope ? `\n\nFocus/scope: ${args.scope}` : "";
  const constraintsBlock =
    args.constraints && args.constraints.length > 0
      ? `\n\nAdditional constraints:\n${args.constraints.map((constraint) => `- ${constraint}`).join("\n")}`
      : "";

  const prompt = `Document outline (${args.chunks.length} chunks total):\n\n${outline}${scopeLine}${constraintsBlock}`;

  const system =
    "You are planning the group structure of a rule book being extracted from this document. " +
    "Propose a set of groups that partition the document's domain by TOPIC (not by document " +
    "section) — each group needs routing metadata another agent will use to decide whether it " +
    "applies to a given question: when_to_use (what this group covers), not_for (what it " +
    'explicitly excludes), and keywords. A reserved "general" catch-all group is appended ' +
    "automatically after your response — do not propose your own general/misc/other group. " +
    `Propose at most ${maxGroups} groups.`;

  const result = await deps.structuredGeneration.generate({
    schema: taxonomySchema(maxGroups),
    prompt,
    system,
    schemaName: "rulebook-taxonomy",
  });

  await deps.rulebookStore.writeExtractionCache(args.rulebookSlug, key, {
    groups: result.object.groups,
  });

  return { groups: appendGeneralGroup(result.object.groups), cached: false, usage: result.usage };
}
