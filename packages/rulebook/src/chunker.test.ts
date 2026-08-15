import { describe, expect, test } from "bun:test";
import { chunkDocument } from "./chunker.ts";

const TINY_OPTS = { targetTokens: 20, maxTokens: 40 } as const; // 80 / 160 chars

function words(count: number, prefix = "word"): string {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(" ");
}

describe("chunkDocument", () => {
  test("no headings: packs paragraphs toward targetTokens without exceeding maxTokens", () => {
    const paragraphs = [words(15, "alpha"), words(15, "beta"), words(15, "gamma"), words(15, "delta")];
    const rawText = paragraphs.join("\n\n");

    const chunks = chunkDocument(rawText, TINY_OPTS);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.headingPath).toEqual([]);
      expect(chunk.tokens).toBeLessThanOrEqual(TINY_OPTS.maxTokens);
    }
    // Every original word survives, in order, across the chunk sequence.
    expect(chunks.map((c) => c.text).join("\n\n")).toBe(rawText);
  });

  test("a giant single section (one heading, no blank lines inside) splits at sentence/space boundaries so no chunk exceeds maxTokens", () => {
    const giantSentence = `${words(200, "term")}.`;
    // 3 headings total so this document is treated as heading-structured,
    // and the middle section alone is the giant one.
    const rawText = [
      "# Intro",
      "short intro text",
      "## Giant Section",
      giantSentence,
      "## Outro",
      "short outro text",
    ].join("\n\n");

    const chunks = chunkDocument(rawText, TINY_OPTS);

    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.tokens).toBeLessThanOrEqual(TINY_OPTS.maxTokens);
    }
    const giantChunks = chunks.filter((c) => c.headingPath.at(-1) === "Giant Section");
    expect(giantChunks.length).toBeGreaterThan(1);
  });

  test("a heading-looking line inside a fenced code block is not treated as a heading", () => {
    // Each section's content is long enough on its own to fill the tiny
    // target budget, so sibling packing can't merge it with a neighbor —
    // that forces one chunk per heading and lets this test actually see
    // each heading's path (a merge would only surface the first section's).
    const rawText = [
      "# Real Heading One",
      words(20, "one"),
      "## Real Heading Two",
      "```",
      "# not a heading",
      "```",
      words(20, "two"),
      "### Real Heading Three",
      words(20, "three"),
    ].join("\n\n");

    const chunks = chunkDocument(rawText, TINY_OPTS);

    const allHeadings = chunks.flatMap((c) => c.headingPath);
    expect(allHeadings).not.toContain("not a heading");
    expect(allHeadings).toContain("Real Heading One");
    expect(allHeadings).toContain("Real Heading Two");
    expect(allHeadings).toContain("Real Heading Three");
    // The fenced line survives as literal chunk text even though it wasn't parsed as a heading.
    expect(chunks.some((c) => c.text.includes("# not a heading"))).toBe(true);
  });

  test("headingPath correctness across nested heading levels, including a level skip", () => {
    const rawText = [
      "# Top",
      "top text",
      "## Middle",
      "middle text",
      "### Deep",
      "deep text",
      "# Second Top",
      "second text",
      "### Skipped To Level Three",
      "skipped text",
    ].join("\n\n");

    const chunks = chunkDocument(rawText, { targetTokens: 5, maxTokens: 4000 });

    const byLeaf = new Map(chunks.map((c) => [c.headingPath.at(-1), c.headingPath]));
    expect(byLeaf.get("Top")).toEqual(["Top"]);
    expect(byLeaf.get("Middle")).toEqual(["Top", "Middle"]);
    expect(byLeaf.get("Deep")).toEqual(["Top", "Middle", "Deep"]);
    expect(byLeaf.get("Second Top")).toEqual(["Second Top"]);
    // Level jumped from 1 straight to 3: level 2 is padded empty, not omitted.
    expect(byLeaf.get("Skipped To Level Three")).toEqual(["Second Top", "", "Skipped To Level Three"]);
  });

  test("is deterministic: identical input and options produce identical output", () => {
    const rawText = [
      "# Heading",
      words(30, "tok"),
      "## Sub",
      words(30, "tok2"),
      "no heading trailing paragraph",
    ].join("\n\n");

    const first = chunkDocument(rawText, TINY_OPTS);
    const second = chunkDocument(rawText, TINY_OPTS);

    expect(second).toEqual(first);
  });

  test("empty (or whitespace-only) input produces no chunks", () => {
    expect(chunkDocument("")).toEqual([]);
    expect(chunkDocument("   \n\n  \n")).toEqual([]);
  });

  test("fewer than 3 headings is treated as unstructured — paragraph packing, no heading path", () => {
    const rawText = ["# Only One Heading", words(10), "", "a trailing paragraph with no heading"].join(
      "\n\n",
    );

    const chunks = chunkDocument(rawText, TINY_OPTS);

    for (const chunk of chunks) {
      expect(chunk.headingPath).toEqual([]);
    }
  });

  test("contentHash is a hex sha256 and differs between distinct chunk texts", () => {
    const rawText = [words(15, "one"), words(15, "two")].join("\n\n");
    const chunks = chunkDocument(rawText, TINY_OPTS);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    const hashes = new Set(chunks.map((c) => c.contentHash));
    expect(hashes.size).toBe(chunks.length);
  });
});
