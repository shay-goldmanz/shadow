import { describe, expect, test } from "bun:test";
import { type Bm25Document, Bm25Index } from "./bm25.ts";

function doc(id: string, fields: Partial<Bm25Document["fields"]>): Bm25Document {
  return {
    id,
    fields: { title: "", when_to_use: "", keywords: "", body: "", ...fields },
  };
}

describe("Bm25Index", () => {
  test("a document containing no query terms scores 0", () => {
    const index = new Bm25Index([doc("a", { body: "completely unrelated content" })]);
    const [hit] = index.score("density tables");
    expect(hit?.score).toBe(0);
  });

  test("a document containing the query term scores above a document that doesn't", () => {
    const index = new Bm25Index([
      doc("has-it", { body: "density is the central idea of this chapter" }),
      doc("lacks-it", { body: "this chapter is about something else entirely" }),
    ]);
    const hits = index.score("density");
    const byId = new Map(hits.map((h) => [h.id, h.score]));
    expect(byId.get("has-it")).toBeGreaterThan(byId.get("lacks-it") ?? 0);
  });

  test("results are sorted by descending score", () => {
    const index = new Bm25Index([
      doc("weak", { body: "density" }),
      doc("strong", { body: "density density density density" }),
      doc("none", { body: "unrelated" }),
    ]);
    const hits = index.score("density");
    expect(hits.map((h) => h.id)).toEqual(["strong", "weak", "none"]);
  });

  test("field boosting: a title match outscores an equal body-only match", () => {
    const index = new Bm25Index([
      doc("title-match", { title: "density", body: "generic filler content here" }),
      doc("body-match", { title: "generic", body: "density filler content here" }),
    ]);
    const hits = index.score("density");
    const byId = new Map(hits.map((h) => [h.id, h.score]));
    expect(byId.get("title-match")).toBeGreaterThan(byId.get("body-match") ?? 0);
  });

  test("field boosting: when_to_use and keywords matches also outscore a body-only match", () => {
    const index = new Bm25Index([
      doc("when-to-use-match", { when_to_use: "density", body: "generic filler content here" }),
      doc("keywords-match", { keywords: "density", body: "generic filler content here" }),
      doc("body-match", { body: "density filler content here" }),
    ]);
    const hits = index.score("density");
    const byId = new Map(hits.map((h) => [h.id, h.score]));
    expect(byId.get("when-to-use-match")).toBeGreaterThan(byId.get("body-match") ?? 0);
    expect(byId.get("keywords-match")).toBeGreaterThan(byId.get("body-match") ?? 0);
  });

  test("a known small corpus produces the expected ranking", () => {
    const index = new Bm25Index([
      doc("linear-density", {
        title: "How Linear handles information density",
        when_to_use: "Designing list views, tables, dashboards",
        keywords: "density, list view, table, row height",
        body: "Linear favors dense, compact rows with minimal padding between cells.",
      }),
      doc("notion-whitespace", {
        title: "How Notion uses whitespace",
        when_to_use: "Designing calm, spacious documents",
        keywords: "whitespace, calm, documents",
        body: "Notion favors generous whitespace and a near-monochrome palette.",
      }),
      doc("epoch-onepager", {
        title: "Designing a one-pager",
        when_to_use: "Editorial single-page layouts",
        keywords: "one-pager, editorial, layout",
        body: "Epoch magazine designs dense, information-rich one-page layouts.",
      }),
    ]);

    const hits = index.score("designing a dense table with tight row height");
    // The Linear chapter is the strongest match on title, when_to_use,
    // keywords, and body all at once; it must rank first.
    expect(hits[0]?.id).toBe("linear-density");
    // Notion (whitespace-focused, the opposite concept) should rank last.
    expect(hits[hits.length - 1]?.id).toBe("notion-whitespace");
  });

  test("empty corpus does not throw and returns no hits", () => {
    const index = new Bm25Index([]);
    expect(index.score("anything")).toEqual([]);
  });

  test("empty query returns every document with score 0, order preserved", () => {
    const index = new Bm25Index([doc("a", { body: "x" }), doc("b", { body: "y" })]);
    const hits = index.score("");
    expect(hits.map((h) => h.score)).toEqual([0, 0]);
  });
});
