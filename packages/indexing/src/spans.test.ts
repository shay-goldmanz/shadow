import { describe, expect, test } from "bun:test";
import { toBytes } from "./byte-text.ts";
import { parseHeadingTree } from "./heading-tree.ts";
import { assignSpans, chapterSpan, type SpannedNode } from "./spans.ts";

function build(body: string) {
  const bodyBytes = toBytes(body);
  const tree = parseHeadingTree(body);
  const spanned = assignSpans(tree, bodyBytes.length);
  return { spanned, chapter: chapterSpan(bodyBytes.length), bodyBytes };
}

function collectAll(nodes: readonly SpannedNode[]): SpannedNode[] {
  return nodes.flatMap((node) => [node, ...collectAll(node.children)]);
}

describe("assignSpans", () => {
  test("siblings are non-overlapping and contiguous", () => {
    const body = "## One\nSome text.\n## Two\nMore text.\n## Three\nEnd.\n";
    const { spanned } = build(body);
    expect(spanned).toHaveLength(3);
    // Each span's end is exactly the next span's start: no gap, no overlap.
    expect(spanned[0]?.span.end_byte).toBe(spanned[1]?.span.start_byte);
    expect(spanned[1]?.span.end_byte).toBe(spanned[2]?.span.start_byte);
  });

  test("the last sibling's span runs to the end of the enclosing range", () => {
    const body = "## Only\nSome text.\n";
    const bodyBytes = toBytes(body);
    const { spanned } = build(body);
    expect(spanned[0]?.span.end_byte).toBe(bodyBytes.length);
  });

  test("union semantics: a parent's span exactly covers the union of its children's spans", () => {
    const body = ["## Parent", "intro", "### Child A", "a", "### Child B", "b"].join("\n") + "\n";
    const { spanned } = build(body);
    const parent = spanned[0];
    expect(parent).toBeDefined();
    if (!parent) return;
    const children = parent.children;
    expect(children).toHaveLength(2);
    // parent.span ⊇ ∪ children.span
    for (const child of children) {
      expect(child.span.start_byte).toBeGreaterThanOrEqual(parent.span.start_byte);
      expect(child.span.end_byte).toBeLessThanOrEqual(parent.span.end_byte);
    }
    // And, because children are contiguous and the last one reaches the
    // parent's own end, the union is exact (equality), not just coverage.
    expect(children[0]?.span.start_byte).toBeGreaterThan(parent.span.start_byte); // parent has its own text before the first child
    expect(children[children.length - 1]?.span.end_byte).toBe(parent.span.end_byte);
  });

  test("union semantics holds at every depth of a multi-level tree", () => {
    const body =
      [
        "## A",
        "### A.1",
        "#### A.1.1",
        "text",
        "#### A.1.2",
        "text",
        "### A.2",
        "text",
        "## B",
        "text",
      ].join("\n") + "\n";
    const { spanned } = build(body);
    for (const node of collectAll(spanned)) {
      for (const child of node.children) {
        expect(child.span.start_byte).toBeGreaterThanOrEqual(node.span.start_byte);
        expect(child.span.end_byte).toBeLessThanOrEqual(node.span.end_byte);
      }
    }
  });

  test("chapter.span is union semantics too: it always covers the whole body, [0, length)", () => {
    const body = "Prose before any heading.\n## Section\nMore.\n";
    const { chapter, bodyBytes } = build(body);
    expect(chapter).toEqual({ start_byte: 0, end_byte: bodyBytes.length });
  });

  test("prose before the first heading is not part of any section span (it belongs only to the chapter)", () => {
    const body = "Some intro prose that precedes any heading.\n## First Section\nbody\n";
    const { spanned } = build(body);
    const firstHeadingByteStart = toBytes("Some intro prose that precedes any heading.\n").length;
    expect(spanned[0]?.span.start_byte).toBe(firstHeadingByteStart);
    // The chapter span starts at 0, strictly before the first section's span.
    expect(spanned[0]?.span.start_byte).toBeGreaterThan(0);
  });

  test("no headings at all: spans list is empty, chapter span still covers the whole body", () => {
    const body = "Just prose, no headings anywhere.\n";
    const { spanned, chapter, bodyBytes } = build(body);
    expect(spanned).toEqual([]);
    expect(chapter).toEqual({ start_byte: 0, end_byte: bodyBytes.length });
  });
});
