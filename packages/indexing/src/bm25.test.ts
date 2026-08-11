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

describe("stopword filtering (T2.8a)", () => {
  test("a query that is entirely stopwords scores nothing, not everything", () => {
    const index = new Bm25Index([
      doc("a", { body: "density is the central idea of this chapter and it matters" }),
      doc("b", { body: "something completely unrelated to anything else" }),
    ]);
    const hits = index.score("and on the with into");
    expect(hits.every((h) => h.score === 0)).toBe(true);
  });

  test("a query sharing only function words with a chapter does not score above zero", () => {
    // The T2.8a scenario found by end-to-end testing: a natural-language
    // query overlapping a chapter only on function words must not score
    // above zero — before this fix it did, won fallback promotion, and
    // returned a weak `promoted` guess instead of an honest miss.
    const irrelevant = doc("irrelevant", {
      body: "Notion favors generous whitespace and a calm reading experience on the desktop.",
    });
    const index = new Bm25Index([irrelevant]);

    // Shares only "and", "on", "the" with the document above (all
    // stopwords) — nothing else. Deliberately excludes "for"/"not"/"when"/
    // "use", which this package keeps unfiltered (see `STOPWORDS`'s doc
    // comment) precisely because they carry routing meaning.
    expect(index.score("and on the")[0]?.score).toBe(0);
  });

  test("the possessive-split 's fragment does not create spurious cross-matches", () => {
    // "Notion's" and "Epoch's" tokenize to `notion`/`epoch` plus a bare `s`
    // fragment each (the apostrophe isn't part of the token regex). Before
    // filtering, that shared `s` token alone was enough to produce a
    // nonzero score between two documents about entirely different things.
    const epoch = doc("epoch", { body: "Epoch's writers value clarity above all." });
    const query = "Notion's approach"; // tokenizes to `notion`, `approach` — no `epoch` anywhere
    expect(new Bm25Index([epoch]).score(query)[0]?.score).toBe(0);
  });

  test("stopwords are removed from both the query and indexed text — a stopword-only field contributes nothing", () => {
    const index = new Bm25Index([doc("a", { body: "the a an of" }), doc("b", { body: "density" })]);
    const hits = index.score("density");
    const byId = new Map(hits.map((h) => [h.id, h.score]));
    expect(byId.get("a")).toBe(0);
    expect(byId.get("b")).toBeGreaterThan(0);
  });

  test("routing vocabulary survives filtering: not/when/use/for still score", () => {
    const index = new Bm25Index([
      doc("has-it", { when_to_use: "Use this only when not designing for empty states" }),
      doc("lacks-it", { body: "generic filler content" }),
    ]);
    const byId = new Map(
      index.score("when to use this, and not for what").map((h) => [h.id, h.score]),
    );
    expect(byId.get("has-it")).toBeGreaterThan(0);
    expect(byId.get("has-it") ?? 0).toBeGreaterThan(byId.get("lacks-it") ?? 0);
  });

  test("the stoplist targets specific known remnants, not every single-letter token", () => {
    // A genuine single-letter query term outside the curated remnant list
    // (s, t, d, ll, m, o, re, ve, y) still scores normally — the filter is
    // not "drop anything short".
    const index = new Bm25Index([doc("a", { body: "x marks the spot" })]);
    expect(index.score("x")[0]?.score).toBeGreaterThan(0);
  });
});
