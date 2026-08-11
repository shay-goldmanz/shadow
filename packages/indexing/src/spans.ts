/**
 * Non-overlapping span assignment with union semantics
 * (`docs/INDEXING.md`, "ASSIGN SPANS").
 *
 * Pure: operates on a `HeadingNode` tree (byte offsets already computed by
 * `heading-tree.ts`) plus the body's total byte length.
 *
 * Union semantics, by construction: a section's span runs from its own
 * heading line to one byte before the next heading at level <= its own
 * (a sibling, or an ancestor's next sibling) — or to the end of the
 * enclosing span if it's the last one. Because child headings always have
 * a *strictly greater* level, they never terminate their parent's span,
 * so a parent's span is contiguous and always covers every byte its
 * children's spans cover: `parent.span ⊇ ∪ children.span` holds by
 * construction, not by an extra union step. The chapter's own span is the
 * degenerate case of the same rule: `[0, bodyByteLength)`, the whole body.
 *
 * Non-overlap holds too: siblings are assigned back-to-front from the end
 * of the enclosing range, so each span's end is exactly one byte before
 * the next span's start.
 */

import type { HeadingNode } from "./heading-tree.ts";
import type { Span } from "./types.ts";

export interface SpannedNode extends HeadingNode {
  readonly span: Span;
  readonly children: readonly SpannedNode[];
}

/**
 * Assign spans to a list of *sibling* heading nodes (all at the same
 * nesting level, in document order) that together occupy
 * `[rangeStart, rangeEnd)`. Recurses into each node's own children with
 * its own span as the enclosing range.
 */
function assignSiblingSpans(
  nodes: readonly HeadingNode[],
  rangeStart: number,
  rangeEnd: number,
): SpannedNode[] {
  const result: SpannedNode[] = [];
  for (const [i, node] of nodes.entries()) {
    const nextSibling = nodes[i + 1];
    // end_byte is inclusive-of-nothing-past: one byte before the next
    // heading at this level (or the end of the enclosing range for the
    // last sibling).
    const end = nextSibling ? nextSibling.startByte : rangeEnd;
    const span: Span = { start_byte: node.startByte, end_byte: end };
    result.push({
      ...node,
      span,
      children: assignSiblingSpans(node.children, node.startByte, end),
    });
  }
  return result;
}

/** Assign spans to a chapter's full top-level heading list, given the chapter body's total byte length. */
export function assignSpans(
  topLevelHeadings: readonly HeadingNode[],
  bodyByteLength: number,
): SpannedNode[] {
  return assignSiblingSpans(topLevelHeadings, 0, bodyByteLength);
}

/** The chapter's own span: union semantics means it is always the whole body. */
export function chapterSpan(bodyByteLength: number): Span {
  return { start_byte: 0, end_byte: bodyByteLength };
}
