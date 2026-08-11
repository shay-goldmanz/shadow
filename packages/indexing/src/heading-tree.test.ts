import { describe, expect, test } from "bun:test";
import { buildHeadingTree, extractHeadings, parseHeadingTree } from "./heading-tree.ts";

describe("extractHeadings", () => {
  test("captures level 2-6 headings, never level 1 (title)", () => {
    const body = "# Title\n\n## Section\n\n### Sub\n";
    const headings = extractHeadings(body);
    expect(headings.map((h) => h.title)).toEqual(["Section", "Sub"]);
    expect(headings.map((h) => h.level)).toEqual([2, 3]);
  });

  test("records byte offsets, not character offsets, for non-ASCII bodies", () => {
    // "日本語" is 3 chars but 9 UTF-8 bytes.
    const body = "日本語\n\n## Heading\n";
    const headings = extractHeadings(body);
    // "日本語" (9 bytes) + "\n" (1) + "\n" (1) = 11 bytes before "## Heading".
    expect(headings[0]?.startByte).toBe(11);
  });

  test("skips headings inside a fenced code block (backtick fence)", () => {
    const body = ["## Real Section", "", "```", "## Not a heading", "```", "", "## Also Real"].join(
      "\n",
    );
    const headings = extractHeadings(body);
    expect(headings.map((h) => h.title)).toEqual(["Real Section", "Also Real"]);
  });

  test("skips headings inside a fenced code block (tilde fence)", () => {
    const body = ["## Real Section", "", "~~~", "## Not a heading", "~~~", "", "## Also Real"].join(
      "\n",
    );
    const headings = extractHeadings(body);
    expect(headings.map((h) => h.title)).toEqual(["Real Section", "Also Real"]);
  });

  test("skips a heading-like line inside an indented (4-space) code block", () => {
    const body = [
      "## Real Section",
      "",
      "    ## Not a heading (indented code)",
      "",
      "## Also Real",
    ].join("\n");
    const headings = extractHeadings(body);
    expect(headings.map((h) => h.title)).toEqual(["Real Section", "Also Real"]);
  });

  test("an unclosed fence swallows the rest of the document", () => {
    const body = ["## Real Section", "```", "## still inside fence"].join("\n");
    const headings = extractHeadings(body);
    expect(headings.map((h) => h.title)).toEqual(["Real Section"]);
  });

  test("a different fence character inside an open fence does not close it", () => {
    const body = ["```", "~~~", "## inside", "```", "## outside"].join("\n");
    const headings = extractHeadings(body);
    expect(headings.map((h) => h.title)).toEqual(["outside"]);
  });

  test("trims trailing whitespace from the heading title", () => {
    const body = "##   Spaced Title   \n";
    expect(extractHeadings(body)[0]?.title).toBe("Spaced Title");
  });

  test("empty body yields no headings", () => {
    expect(extractHeadings("")).toEqual([]);
  });
});

describe("buildHeadingTree", () => {
  test("deep nesting: level 2 -> 3 -> 4 -> 5 -> 6 all chain as parent/child", () => {
    const body = "## L2\n### L3\n#### L4\n##### L5\n###### L6\n";
    const tree = buildHeadingTree(extractHeadings(body));
    expect(tree).toHaveLength(1);
    let node = tree[0];
    const levels: number[] = [];
    while (node) {
      levels.push(node.level);
      node = node.children[0];
    }
    expect(levels).toEqual([2, 3, 4, 5, 6]);
  });

  test("a level skip (## then ####) nests the deeper heading directly under the shallower one", () => {
    const body = "## Parent\n#### Grandchild\n";
    const tree = buildHeadingTree(extractHeadings(body));
    expect(tree).toHaveLength(1);
    expect(tree[0]?.title).toBe("Parent");
    expect(tree[0]?.children).toHaveLength(1);
    expect(tree[0]?.children[0]?.title).toBe("Grandchild");
    expect(tree[0]?.children[0]?.level).toBe(4);
  });

  test("siblings at the same level stay flat, not nested", () => {
    const body = "## One\n## Two\n## Three\n";
    const tree = buildHeadingTree(extractHeadings(body));
    expect(tree.map((n) => n.title)).toEqual(["One", "Two", "Three"]);
    expect(tree.every((n) => n.children.length === 0)).toBe(true);
  });

  test("a shallower heading after a deep chain pops back to root", () => {
    const body = "## A\n### A.1\n#### A.1.1\n## B\n";
    const tree = buildHeadingTree(extractHeadings(body));
    expect(tree.map((n) => n.title)).toEqual(["A", "B"]);
    expect(tree[0]?.children[0]?.children[0]?.title).toBe("A.1.1");
  });

  test("duplicate sibling headings get -2, -3 disambiguated slugs", () => {
    const body = "## Overview\n## Overview\n## Overview\n";
    const tree = buildHeadingTree(extractHeadings(body));
    expect(tree.map((n) => n.slug)).toEqual(["overview", "overview-2", "overview-3"]);
  });

  test("duplicate slugs are scoped to siblings, not global", () => {
    const body = "## Overview\n### Detail\n## Another\n### Detail\n";
    const tree = buildHeadingTree(extractHeadings(body));
    // "Detail" appears once under each "## " parent — each should get the
    // plain slug, not -2, because they're never siblings of each other.
    expect(tree[0]?.children[0]?.slug).toBe("detail");
    expect(tree[1]?.children[0]?.slug).toBe("detail");
  });

  test("a `#` title line is never captured as a section", () => {
    const body = "# Chapter Title\n\n## First Section\n";
    const tree = buildHeadingTree(extractHeadings(body));
    expect(tree.map((n) => n.title)).toEqual(["First Section"]);
  });
});

describe("parseHeadingTree", () => {
  test("extract + nest in one call", () => {
    const body = "## A\n### A.1\n";
    expect(parseHeadingTree(body)).toEqual(buildHeadingTree(extractHeadings(body)));
  });
});
