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

  test("recognizes derived ([^=label]) and operator ([^~label]) citation markers, not just sourced ([^label])", () => {
    const blocks = parseChapterBody(
      "Linear uses 4px spacing.[^lin-4px] This follows from that.[^=derived-claim] I said so myself.[^~op-belief]",
    );
    expect(blocks).toEqual([
      {
        type: "paragraph",
        segments: [
          { type: "text", text: "Linear uses 4px spacing." },
          { type: "citation", label: "lin-4px" },
          { type: "text", text: " This follows from that." },
          { type: "citation", label: "derived-claim" },
          { type: "text", text: " I said so myself." },
          { type: "citation", label: "op-belief" },
        ],
      },
    ]);
  });

  test("strips derived and operator footnote definition lines too, not just sourced ones", () => {
    const blocks = parseChapterBody(
      "A derived claim.[^=derived-claim]\n\n[^=derived-claim]: raw definition text, not shown\n\n" +
        "An operator claim.[^~op-belief]\n\n[^~op-belief]: another raw definition, not shown\n\n" +
        "Trailing paragraph.",
    );
    expect(blocks).toEqual([
      {
        type: "paragraph",
        segments: [
          { type: "text", text: "A derived claim." },
          { type: "citation", label: "derived-claim" },
        ],
      },
      {
        type: "paragraph",
        segments: [
          { type: "text", text: "An operator claim." },
          { type: "citation", label: "op-belief" },
        ],
      },
      { type: "paragraph", segments: [{ type: "text", text: "Trailing paragraph." }] },
    ]);
  });

  test("empty body yields no blocks", () => {
    expect(parseChapterBody("")).toEqual([]);
    expect(parseChapterBody("\n\n\n")).toEqual([]);
  });
});
