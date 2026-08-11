import { describe, expect, test } from "bun:test";
import { parseChapterBody } from "./chapter-body.ts";

describe("parseChapterBody", () => {
  test("splits headings from paragraphs", () => {
    const blocks = parseChapterBody("# Title\n\nFirst paragraph.\n\n## Sub\n\nSecond paragraph.");
    expect(blocks).toEqual([
      { type: "heading", level: 1, segments: [{ type: "text", text: "Title" }] },
      { type: "paragraph", segments: [{ type: "text", text: "First paragraph." }] },
      { type: "heading", level: 2, segments: [{ type: "text", text: "Sub" }] },
      { type: "paragraph", segments: [{ type: "text", text: "Second paragraph." }] },
    ]);
  });

  test("extracts citation markers as distinct segments", () => {
    const blocks = parseChapterBody(
      "Linear uses 4px spacing.[^lin-4px] Notion uses whitespace.[^notion-ws]",
    );
    expect(blocks).toEqual([
      {
        type: "paragraph",
        segments: [
          { type: "text", text: "Linear uses 4px spacing." },
          { type: "citation", label: "lin-4px" },
          { type: "text", text: " Notion uses whitespace." },
          { type: "citation", label: "notion-ws" },
        ],
      },
    ]);
  });

  test("wraps lines within a paragraph onto one block", () => {
    const blocks = parseChapterBody("Line one\nline two\n\nNext paragraph.");
    expect(blocks).toEqual([
      { type: "paragraph", segments: [{ type: "text", text: "Line one line two" }] },
      { type: "paragraph", segments: [{ type: "text", text: "Next paragraph." }] },
    ]);
  });

  test("strips footnote definition lines rather than rendering them as prose", () => {
    const blocks = parseChapterBody(
      "A claim.[^lin-4px]\n\n[^lin-4px]: raw definition text, not shown\n\nAnother paragraph.",
    );
    expect(blocks).toEqual([
      {
        type: "paragraph",
        segments: [
          { type: "text", text: "A claim." },
          { type: "citation", label: "lin-4px" },
        ],
      },
      { type: "paragraph", segments: [{ type: "text", text: "Another paragraph." }] },
    ]);
  });

  test("empty body yields no blocks", () => {
    expect(parseChapterBody("")).toEqual([]);
    expect(parseChapterBody("\n\n\n")).toEqual([]);
  });
});
