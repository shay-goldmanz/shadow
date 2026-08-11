import { describe, expect, test } from "bun:test";
import { sliceBytesToText, toBytes } from "./byte-text.ts";
import { buildChapterIndexNode } from "./chapter-index.ts";
import { buildTrace, citationForChapter, citationForSection } from "./trace.ts";

const body = [
  "## Density vs whitespace",
  "Linear renders rows at 32px and truncates aggressively.",
  "## Truncation rules",
  "Never truncate a primary label.",
].join("\n");

const chapterNode = buildChapterIndexNode({
  ulid: "01J8X7QK3M2F5R7T9V0W1Y2Z3A",
  volumeTitle: "Interface Design",
  chapterSlug: "linear-density",
  chapterTitle: "How Linear handles information density",
  body,
  frontmatter: { when_to_use: "Designing dense tables" },
  file: "volumes/ui-design/chapters/linear-density.md",
});

describe("citationForChapter — hash-pinned, span slices the real body", () => {
  test("carries node_id, content_hash, and file straight from the index node", () => {
    const citation = citationForChapter(chapterNode);
    expect(citation.node_id).toBe(chapterNode.node_id);
    expect(citation.content_hash).toBe(chapterNode.content_hash);
    expect(citation.file).toBe("volumes/ui-design/chapters/linear-density.md");
    expect(citation.path).toEqual(["Interface Design", "How Linear handles information density"]);
  });

  test("the span, applied to the real body bytes, reproduces the actual chapter text — not model prose", () => {
    const citation = citationForChapter(chapterNode);
    const sliced = sliceBytesToText(
      toBytes(body),
      citation.span.start_byte,
      citation.span.end_byte,
    );
    expect(sliced).toBe(body); // chapter span is [0, EOF), union semantics
  });
});

describe("citationForSection — span slices the real section text", () => {
  test("a citation built from an actual section slices exactly that section's real text", () => {
    const longBody = [
      "## Density vs whitespace",
      "x".repeat(4000),
      "## Truncation rules",
      "Never truncate a primary label.",
    ].join("\n");
    const longChapter = buildChapterIndexNode({
      ulid: "01J8X7QK3M2F5R7T9V0W1Y2Z3A",
      volumeTitle: "Interface Design",
      chapterSlug: "linear-density",
      chapterTitle: "How Linear handles information density",
      body: longBody,
      frontmatter: {},
      file: "volumes/ui-design/chapters/linear-density.md",
    });
    const truncationRules = longChapter.sections?.find((s) => s.title === "Truncation rules");
    expect(truncationRules).toBeDefined();
    if (!truncationRules) {
      throw new Error("unreachable");
    }

    const citation = citationForSection(longChapter, truncationRules);
    expect(citation.node_id).toBe(truncationRules.node_id);
    expect(citation.content_hash).toBe(truncationRules.content_hash);
    expect(citation.path).toEqual([
      "Interface Design",
      "How Linear handles information density",
      "Truncation rules",
    ]);

    const bytes = toBytes(longBody);
    const sliced = sliceBytesToText(bytes, citation.span.start_byte, citation.span.end_byte);
    expect(sliced).toContain("Never truncate a primary label.");
    expect(sliced).toContain("## Truncation rules");
    // Not the whole chapter — only this section's own text.
    expect(sliced).not.toContain("Density vs whitespace");
  });
});

describe("buildTrace", () => {
  test("assembles query, rounds, steps, citations, and verdict verbatim", () => {
    const citation = citationForChapter(chapterNode);
    const trace = buildTrace({
      query: "design a one-pager",
      rounds: 1,
      steps: [
        { step: "navigate", chose: [chapterNode.node_id], rejected: [] },
        { step: "grade", verdict: { kind: "sufficient" } },
      ],
      citations: [citation],
      verdict: { kind: "sufficient" },
    });
    expect(trace.query).toBe("design a one-pager");
    expect(trace.rounds).toBe(1);
    expect(trace.trace).toHaveLength(2);
    expect(trace.citations).toEqual([citation]);
    expect(trace.verdict).toEqual({ kind: "sufficient" });
  });
});
