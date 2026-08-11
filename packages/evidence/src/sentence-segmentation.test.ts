import { describe, expect, test } from "bun:test";
import { segmentChapterBody, splitSentences } from "./sentence-segmentation.ts";

describe("splitSentences", () => {
  test("splits on terminal punctuation", () => {
    expect(splitSentences("First sentence. Second sentence!")).toEqual([
      "First sentence.",
      "Second sentence!",
    ]);
  });

  test("keeps a trailing footnote marker attached to its sentence", () => {
    const paragraph =
      "Linear renders its sidebar on a 4px spacing scale.[^lin-4px] Notion leans on generous whitespace instead.[^notion-ws]";
    expect(splitSentences(paragraph)).toEqual([
      "Linear renders its sidebar on a 4px spacing scale.[^lin-4px]",
      "Notion leans on generous whitespace instead.[^notion-ws]",
    ]);
  });

  test("does not split decimal numbers", () => {
    expect(splitSentences("The grid uses a 4.5px baseline. It is unusual.")).toEqual([
      "The grid uses a 4.5px baseline.",
      "It is unusual.",
    ]);
  });

  test("a trailing fragment with no terminal punctuation is kept", () => {
    expect(splitSentences("A sentence. A trailing fragment")).toEqual([
      "A sentence.",
      "A trailing fragment",
    ]);
  });
});

describe("segmentChapterBody", () => {
  test("excludes headings, list items, code fences, and blockquotes", () => {
    const body = [
      "# A heading that ends with a period.",
      "",
      "Some real prose here. It has two sentences.",
      "",
      "- A list item that looks like a claim.",
      "- Another one.",
      "",
      "```ts",
      "const claim = 'not a sentence.';",
      "```",
      "",
      "> A quoted line that should not count.",
      "",
      "Final paragraph sentence.",
    ].join("\n");

    const sentences = segmentChapterBody(body).map((s) => s.text);
    expect(sentences).toEqual([
      "Some real prose here.",
      "It has two sentences.",
      "Final paragraph sentence.",
    ]);
  });

  test("reports which sentences are already marked", () => {
    const body =
      "Linear uses a 4px grid.[^lin-4px] This is unmarked connective prose. Notion differs.[^=notion-derived]";
    const sentences = segmentChapterBody(body);
    expect(sentences.map((s) => s.marked)).toEqual([true, false, true]);
  });

  test("joins soft-wrapped lines within one paragraph as shared context", () => {
    const body = "Line one of a paragraph\nthat wraps onto line two. A second sentence.";
    const sentences = segmentChapterBody(body);
    expect(sentences).toHaveLength(2);
    expect(sentences[0]?.context).toBe(
      "Line one of a paragraph that wraps onto line two. A second sentence.",
    );
  });
});
