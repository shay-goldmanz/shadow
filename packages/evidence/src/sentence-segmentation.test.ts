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
  test("excludes headings and code fences; segments list-item content as prose; blockquote content is form-excluded but still counted (D25)", () => {
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

    const sentences = segmentChapterBody(body);

    // The heading and the code-fence content never appear anywhere.
    expect(sentences.some((s) => s.text.includes("heading"))).toBe(false);
    expect(sentences.some((s) => s.text.includes("not a sentence"))).toBe(false);

    // D25: list-item text is segmented like ordinary prose — only the `- `
    // marker is scaffolding, not the sentence it introduces.
    expect(sentences.map((s) => s.text)).toEqual([
      "Some real prose here.",
      "It has two sentences.",
      "A list item that looks like a claim.",
      "Another one.",
      "A quoted line that should not count.",
      "Final paragraph sentence.",
    ]);

    // D25: the blockquote line is still excluded from the audited sweep
    // (no writer can hide an assertion inside a marked-false-forever
    // quote)...
    const listSentences = sentences.filter((s) => s.text.includes("list item"));
    expect(listSentences.every((s) => !s.formExcluded)).toBe(true);
    const blockquoteSentence = sentences.find((s) => s.text.includes("quoted line"));
    expect(blockquoteSentence?.formExcluded).toBe(true);
    // ...but it's still present in the segmentation output (not silently
    // dropped) so a caller can fold it into the narrative budget.
    expect(sentences).toContainEqual(
      expect.objectContaining({ text: "A quoted line that should not count.", formExcluded: true }),
    );
  });

  test("a footnoted list item is detected as marked, just like a footnoted paragraph sentence (D25)", () => {
    const body = "- Linear caps row height at 32px.[^lin-32]\n- Notion uses variable row height.";
    const sentences = segmentChapterBody(body);
    expect(sentences.map((s) => ({ text: s.text, marked: s.marked }))).toEqual([
      { text: "Linear caps row height at 32px.[^lin-32]", marked: true },
      { text: "Notion uses variable row height.", marked: false },
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
