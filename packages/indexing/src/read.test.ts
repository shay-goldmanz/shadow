import { describe, expect, test } from "bun:test";
import { buildChapterIndexNode } from "./chapter-index.ts";
import { buildIndexDocument } from "./corpus-index.ts";
import { resolveReadContext } from "./read.ts";
import type { IndexDocument } from "./types.ts";
import { buildVolumeIndexNode } from "./volume-index.ts";

const longBody = [
  "## Density vs whitespace",
  "x".repeat(4000),
  "### Row height",
  "y".repeat(200),
  "## Truncation rules",
  "z".repeat(200),
].join("\n");

const linear = buildChapterIndexNode({
  ulid: "01LINEAR",
  volumeTitle: "Interface Design",
  chapterSlug: "linear-density",
  chapterTitle: "How Linear handles information density",
  body: longBody,
  frontmatter: { when_to_use: "Designing dense tables" },
  file: "volumes/ui-design/chapters/linear-density.md",
});

const notion = buildChapterIndexNode({
  ulid: "01NOTION",
  volumeTitle: "Interface Design",
  chapterSlug: "notion-whitespace",
  chapterTitle: "How Notion uses whitespace",
  body: "Some prose.\n",
  frontmatter: {},
  file: "volumes/ui-design/chapters/notion-whitespace.md",
});

const volumeNode = buildVolumeIndexNode({
  volumeSlug: "ui-design",
  volumeTitle: "Interface Design",
  whenToUse: "Designing UI: layout, density, navigation.",
  notFor: undefined,
  keywords: undefined,
  chapters: [linear, notion],
});

const document: IndexDocument = buildIndexDocument([volumeNode]);

describe("resolveReadContext — chapter-level reads", () => {
  test("heading_path is [volumeTitle, chapterTitle]; parent_when_to_use is the volume's", () => {
    const ctx = resolveReadContext(document, linear.node_id);
    expect(ctx?.kind).toBe("chapter");
    expect(ctx?.heading_path).toEqual([
      "Interface Design",
      "How Linear handles information density",
    ]);
    expect(ctx?.parent_when_to_use).toBe("Designing UI: layout, density, navigation.");
    expect(ctx?.content_hash).toBe(linear.content_hash);
    expect(ctx?.span).toEqual(linear.span);
  });

  test("sibling_titles lists other chapters in the same volume, not itself", () => {
    const ctx = resolveReadContext(document, linear.node_id);
    expect(ctx?.sibling_titles).toEqual(["How Notion uses whitespace"]);
  });

  test("chapterSlug/volumeId identify where to fetch the body from", () => {
    const ctx = resolveReadContext(document, linear.node_id);
    expect(ctx?.volumeId).toBe("ui-design");
    expect(ctx?.chapterSlug).toBe("linear-density");
  });
});

describe("resolveReadContext — section-level reads", () => {
  const rowHeight = linear.sections?.[0]?.sections?.[0];

  test("heading_path extends the chapter's path with the section's own heading path", () => {
    const nested = rowHeight;
    expect(nested).toBeDefined();
    if (!nested) {
      throw new Error("unreachable");
    }
    const ctx = resolveReadContext(document, nested.node_id);
    expect(ctx?.kind).toBe("section");
    expect(ctx?.heading_path).toEqual([
      "Interface Design",
      "How Linear handles information density",
      "Density vs whitespace",
      "Row height",
    ]);
  });

  test("parent_when_to_use is the enclosing chapter's when_to_use, not the volume's", () => {
    const nested = rowHeight;
    if (!nested) {
      throw new Error("unreachable");
    }
    const ctx = resolveReadContext(document, nested.node_id);
    expect(ctx?.parent_when_to_use).toBe("Designing dense tables");
  });

  test("sibling_titles for a top-level section lists other top-level sections in the same chapter", () => {
    const densityVsWhitespace = linear.sections?.[0];
    expect(densityVsWhitespace).toBeDefined();
    if (!densityVsWhitespace) {
      throw new Error("unreachable");
    }
    const ctx = resolveReadContext(document, densityVsWhitespace.node_id);
    expect(ctx?.sibling_titles).toEqual(["Truncation rules"]);
  });

  test("content_hash and span come from the section, not the chapter", () => {
    const nested = rowHeight;
    if (!nested) {
      throw new Error("unreachable");
    }
    const ctx = resolveReadContext(document, nested.node_id);
    expect(ctx?.content_hash).toBe(nested.content_hash);
    expect(ctx?.span).toEqual(nested.span);
  });
});

describe("resolveReadContext — unknown node_id", () => {
  test("returns undefined rather than throwing", () => {
    expect(resolveReadContext(document, "does-not-exist")).toBeUndefined();
  });
});
