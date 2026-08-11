/**
 * Check 6 — the `merge_tree` cost model, inverted (D14, D11a): "if a
 * chapter is so large that reading it costs more than routing into it
 * would, tell the operator to split it." Pure computation, no model — this
 * is the same `tree_cost(v) = R + max(S_residual(v), max_c tree_cost(c))`
 * formula D11a explicitly rejects as a *runtime* optimizer at our scale
 * (retrieval never needs it: the calling agent just reads the whole
 * chapter index) but keeps as a genuinely useful *lint* rule: same math,
 * a different consumer — the operator deciding whether to split a
 * chapter, not the router deciding whether to descend.
 *
 * **This repository's docs give the formula's shape but not R's or
 * S_residual's exact operational definitions** (`docs/INDEXING.md`
 * explicitly declines to build this as runtime machinery, so it was never
 * pinned down operationally). Resolved here, flagged per this package's
 * own precedent of documenting interpretive amendments (see `types.ts`'s
 * `Span` doc for T2.2's version of the same thing):
 *
 * - **`R`** — "the routing-row cost" (`docs/INDEXING.md`/D11a: a routing
 *   row is `title + when_to_use + not_for + keywords`, "~120 tokens" for a
 *   typical chapter). Used here as a single constant
 *   (`DEFAULT_ROUTING_ROW_TOKENS`), not derived per-chapter from each
 *   chapter's own frontmatter length — the formula names it `R`, not
 *   `R(v)`, and a constant is what makes the expected cost of any fixture
 *   hand-computable in tests, which the brief requires. Configurable via
 *   `CostModelOptions.routingRowTokens`.
 * - **`S_residual(v)`** — a node's own text, *excluding* its children's
 *   text — exactly `hashing.ts`'s `ownText(v)` (`docs/INDEXING.md`:
 *   "own_text(v) = bytes in v.span not covered by any child"), but
 *   computed from already-built `tokens` fields rather than re-reading
 *   chapter bodies (a lint check over an `IndexDocument` has no bytes to
 *   re-slice, and does not need any — `tokens` already carries union
 *   semantics: "chapter's tokens plainly means its full body", so
 *   `node.tokens - Σ(immediate children's tokens)` is that same
 *   own-text-only quantity, in tokens instead of bytes). Floored at `0`:
 *   token-count subtraction can go slightly negative from
 *   `estimateTokens`'s per-node ceil-rounding, never meaningfully so at
 *   this package's scale (≤6 rounding errors of ≤1 token each per node).
 * - **`max_c tree_cost(c)`** over an empty child set is `0` (`Math.max()`
 *   with no arguments is `-Infinity` in JS, which is never what a "no
 *   children" leaf should contribute) — the recursion's base case,
 *   `tree_cost(leaf) = R + S_residual(leaf) = R + leaf.tokens`.
 *
 * **The flag itself** compares, per chapter, the cost of resolving a query
 * that lands there two ways: `flatCost = R + chapter.tokens` (route to the
 * chapter once, then read the *whole* body — what happens today, since
 * only chapters/volumes route; sections never do) against
 * `structuredCost = tree_cost(chapter)` (route to the chapter, then in the
 * worst case either read its own residual prose or descend into its single
 * most expensive branch — never *all* branches, which is exactly the
 * saving a good section split buys).
 *
 * **The equality-gate fix (Wave 2 review, I-5).** A chapter with no
 * internal structure has `structuredCost == flatCost` by construction
 * (`S_residual` is the whole body when there are no children to subtract)
 * — never `>`. Flagging on bare `structuredCost >= flatCost`, as this
 * check originally did, therefore flagged *every* section-less chapter,
 * including ordinary short ones: `chapter-index.ts`'s
 * `SECTION_TOKEN_THRESHOLD` (800 tokens) means a chapter never grows a
 * section tree below that size, and this package's whole design range is
 * 300-3,000 words (`docs/INDEXING.md`), so most healthy chapters are
 * childless and got warned regardless of size — burying the genuine
 * "wall of text" signal in noise. Verified directly: a 150-token childless
 * chapter was flagged before this fix.
 *
 * The fix gates the equality case on size: only a childless chapter that
 * has *also* crossed `SECTION_TOKEN_THRESHOLD` — large enough that the
 * indexer would have built it a section tree had the Markdown had any
 * headings at all — counts as the real "wall of text" case. A chapter
 * *with* sections is unaffected by the gate and still flags on plain `>=`,
 * because there `structuredCost` closing the gap with (or exceeding)
 * `flatCost` means one branch so dominates the others that descending buys
 * almost nothing over reading the whole thing — the "one section is doing
 * all the work, split it out" signal, which has nothing to do with overall
 * chapter size and should not be gated by it.
 */

import { SECTION_TOKEN_THRESHOLD } from "./chapter-index.ts";
import type { LintCheck, LintCheckResult, LintFinding } from "./lint-types.ts";
import type { ChapterIndexNode, IndexDocument, SectionIndexNode } from "./types.ts";

/** D11a's own figure for a typical routing row: `title + when_to_use + not_for + keywords`, "~120 tokens". */
export const DEFAULT_ROUTING_ROW_TOKENS = 120;

export interface CostModelOptions {
  /** The constant `R` — token cost of one routing-row read. Defaults to `DEFAULT_ROUTING_ROW_TOKENS`. */
  readonly routingRowTokens?: number;
}

/** The minimal shape `treeCost` needs — deliberately narrower than `ChapterIndexNode`/`SectionIndexNode` so a caller (or a test) can hand-construct a cost tree directly, the same way `passages.ts`'s `PassageSource` narrows what `assemblePassages` needs. */
export interface CostNode {
  readonly tokens: number;
  readonly children: readonly CostNode[];
}

function sectionToCostNode(section: SectionIndexNode): CostNode {
  return { tokens: section.tokens, children: (section.sections ?? []).map(sectionToCostNode) };
}

function chapterToCostNode(chapter: ChapterIndexNode): CostNode {
  return { tokens: chapter.tokens, children: (chapter.sections ?? []).map(sectionToCostNode) };
}

function residual(node: CostNode): number {
  const childrenTokens = node.children.reduce((sum, child) => sum + child.tokens, 0);
  return Math.max(0, node.tokens - childrenTokens);
}

/**
 * `tree_cost(v) = R + max(S_residual(v), max_c tree_cost(c))`. `R` applies
 * once per call — this package's sections never carry their own routing
 * row (`docs/INDEXING.md`: "Do sections route? No."), so a chapter's own
 * `R` is the only routing cost paid anywhere in its subtree; descending
 * further costs only what there is to read.
 */
export function treeCost(node: CostNode, routingRowTokens: number): number {
  const childCosts = node.children.map((child) => treeCost(child, routingRowTokens));
  const worstChild = childCosts.length > 0 ? Math.max(...childCosts) : 0;
  return routingRowTokens + Math.max(residual(node), worstChild);
}

export interface CostModelFindingData {
  readonly flatCost: number;
  readonly structuredCost: number;
  readonly chapterTokens: number;
}

/** Run the cost-model check over every chapter in the corpus. */
export function checkChapterCost(
  document: IndexDocument,
  options: CostModelOptions = {},
): LintCheckResult {
  const routingRowTokens = options.routingRowTokens ?? DEFAULT_ROUTING_ROW_TOKENS;
  const findings: LintFinding[] = [];

  for (const volume of document.volumes) {
    for (const chapter of volume.chapters) {
      const structuredCost = treeCost(chapterToCostNode(chapter), routingRowTokens);
      const flatCost = routingRowTokens + chapter.tokens;

      // A childless chapter always has structuredCost === flatCost (see
      // this module's doc comment) — that equality is only the genuine
      // wall-of-text signal once the chapter is large enough that it
      // *should* have grown a section tree (`SECTION_TOKEN_THRESHOLD`).
      // A chapter with sections is never gated: `>` there already means
      // real structural inefficiency regardless of size.
      const hasSections = (chapter.sections?.length ?? 0) > 0;
      const isGenuineWallOfText =
        structuredCost === flatCost && chapter.tokens >= SECTION_TOKEN_THRESHOLD;
      const flagged = hasSections ? structuredCost >= flatCost : isGenuineWallOfText;

      if (flagged) {
        findings.push({
          code: "chapter-too-large",
          severity: "warning",
          message: `"${chapter.title}" (${chapter.tokens} tokens) costs as much or more to route into (${structuredCost} tokens, worst case) as it would to just read whole (${flatCost} tokens) — its internal structure isn't buying navigation any savings; consider splitting it into a separate chapter`,
          nodeIds: [chapter.node_id],
          data: {
            flatCost,
            structuredCost,
            chapterTokens: chapter.tokens,
          } satisfies CostModelFindingData,
        });
      }
    }
  }

  return { checkId: "cost-model", requiresModel: false, findings };
}

export const costModelCheck: LintCheck<IndexDocument> = {
  id: "cost-model",
  requiresModel: false,
  run: (document) => checkChapterCost(document),
};
