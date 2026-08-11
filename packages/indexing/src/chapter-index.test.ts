import { describe, expect, test } from "bun:test";
import { buildChapterIndexNode, SECTION_TOKEN_THRESHOLD } from "./chapter-index.ts";
import { estimateTokens } from "./tokens.ts";

const ULID = "01J8X7QK3M2F5R7T9V0W1Y2Z3A";

function makeInput(overrides: Partial<Parameters<typeof buildChapterIndexNode>[0]> = {}) {
  return {
    ulid: ULID,
    volumeTitle: "Interface Design",
    chapterSlug: "linear-ui-density",
    chapterTitle: "How Linear handles information density",
    body: "## Density vs whitespace\nRow height and truncation rules.\n",
    frontmatter: {},
    file: "volumes/ui-design/chapters/linear-ui-density.md",
    ...overrides,
  };
}

describe("buildChapterIndexNode — identity, path, and frontmatter mapping", () => {
  test("node_id is the chapter's ULID; kind, title, slug, path, file are set verbatim", () => {
    const node = buildChapterIndexNode(makeInput());
    expect(node.node_id).toBe(ULID);
    expect(node.kind).toBe("chapter");
    expect(node.title).toBe("How Linear handles information density");
    expect(node.slug).toBe("linear-ui-density");
    expect(node.path).toEqual(["Interface Design", "How Linear handles information density"]);
    expect(node.file).toBe("volumes/ui-design/chapters/linear-ui-density.md");
  });

  test("maps the full documented frontmatter routing schema", () => {
    const node = buildChapterIndexNode(
      makeInput({
        frontmatter: {
          when_to_use: "Designing list views, tables, dashboards.",
          not_for: "marketing pages, onboarding flows",
          keywords: ["density", "list view", "row height"],
          confidence: "high",
          supersedes: ["01J8A2QK3M2F5R7T9V0W1Y2Z3B"],
          aliases: ["ui-row-density"],
          updated: "2026-08-11",
        },
      }),
    );
    expect(node.when_to_use).toBe("Designing list views, tables, dashboards.");
    expect(node.not_for).toBe("marketing pages, onboarding flows");
    expect(node.keywords).toEqual(["density", "list view", "row height"]);
    expect(node.confidence).toBe("high");
    expect(node.supersedes).toEqual(["01J8A2QK3M2F5R7T9V0W1Y2Z3B"]);
    expect(node.aliases).toEqual(["ui-row-density"]);
    expect(node.updated).toBe("2026-08-11");
  });

  test("missing/invalid frontmatter fields are simply absent, not thrown", () => {
    const node = buildChapterIndexNode(
      makeInput({ frontmatter: { confidence: "not-a-real-value" } }),
    );
    expect(node.when_to_use).toBeUndefined();
    expect(node.confidence).toBeUndefined();
    expect(node.keywords).toBeUndefined();
  });
});

describe("buildChapterIndexNode — span (union semantics)", () => {
  test("chapter span always covers the entire body, [0, bodyByteLength)", () => {
    const body = "## A\ntext\n## B\ntext\n";
    const node = buildChapterIndexNode(makeInput({ body }));
    expect(node.span).toEqual({ start_byte: 0, end_byte: Buffer.byteLength(body, "utf8") });
  });

  test("a body that starts with prose before the first heading: the chapter span still covers it, and the prose is part of the chapter's own content_hash input", () => {
    const bodyWithProse = "Intro prose before any heading.\n## Section\nsection text\n";
    const bodyWithDifferentProse = "Different intro prose entirely.\n## Section\nsection text\n";

    const withProse = buildChapterIndexNode(makeInput({ body: bodyWithProse }));
    const withDifferentProse = buildChapterIndexNode(makeInput({ body: bodyWithDifferentProse }));

    // The leading prose is outside any section span, so it only affects
    // the chapter's own content_hash (and therefore subtree_hash) — not
    // captured anywhere else — but it must be captured *somewhere*.
    expect(withProse.content_hash).not.toBe(withDifferentProse.content_hash);
    expect(withProse.span.start_byte).toBe(0);
  });
});

// estimateTokens is chars/4 rounded up; build a body whose single section
// comfortably lands on the requested side of the threshold.
function bodyWithTokens(targetTokens: number): string {
  const charsNeeded = targetTokens * 4;
  return `## Only Section\n${"x".repeat(charsNeeded)}\n`;
}

describe("buildChapterIndexNode — section threshold (800 tokens)", () => {
  test("below threshold: no `sections`, headings collapse into `key_items`", () => {
    const body = bodyWithTokens(SECTION_TOKEN_THRESHOLD - 100);
    expect(estimateTokens(body)).toBeLessThan(SECTION_TOKEN_THRESHOLD);

    const node = buildChapterIndexNode(makeInput({ body }));
    expect(node.sections).toBeUndefined();
    expect(node.key_items).toEqual(["Only Section"]);
  });

  test("at/above threshold: full `sections` tree, no `key_items`", () => {
    const body = bodyWithTokens(SECTION_TOKEN_THRESHOLD + 200);
    expect(estimateTokens(body)).toBeGreaterThanOrEqual(SECTION_TOKEN_THRESHOLD);

    const node = buildChapterIndexNode(makeInput({ body }));
    expect(node.sections).toBeDefined();
    expect(node.sections?.[0]?.title).toBe("Only Section");
    expect(node.key_items).toBeUndefined();
  });

  test("below-threshold key_items includes every heading in document order, even nested ones", () => {
    const short = "## Top\nsmall\n### Nested\nsmall\n## Second\nsmall\n";
    expect(estimateTokens(short)).toBeLessThan(SECTION_TOKEN_THRESHOLD);
    const node = buildChapterIndexNode(makeInput({ body: short }));
    expect(node.key_items).toEqual(["Top", "Nested", "Second"]);
  });

  test("a chapter with no headings at all, above threshold: sections is an empty-but-present array semantically absent of nodes", () => {
    const body = "x".repeat((SECTION_TOKEN_THRESHOLD + 100) * 4);
    const node = buildChapterIndexNode(makeInput({ body }));
    // No headings -> no section nodes to build, and no key_items either
    // (the collapse rule only applies below the threshold).
    expect(node.sections).toEqual([]);
    expect(node.key_items).toBeUndefined();
  });
});

describe("buildChapterIndexNode — section tree shape", () => {
  test("node_id is `<chapter ULID>#<slug>` for a top-level section", () => {
    const body = `## Density vs whitespace\n${"x".repeat(4000)}\n`;
    const node = buildChapterIndexNode(makeInput({ body }));
    expect(node.sections?.[0]?.node_id).toBe(`${ULID}#density-vs-whitespace`);
  });

  test("node_id for a nested section includes the full slugified heading path", () => {
    const body = `## Parent\n${"x".repeat(4000)}\n### Child\n${"y".repeat(200)}\n`;
    const node = buildChapterIndexNode(makeInput({ body }));
    const parent = node.sections?.[0];
    expect(parent?.sections?.[0]?.node_id).toBe(`${ULID}#parent/child`);
  });

  test("heading_path accumulates ancestor titles, self last", () => {
    const body = `## Parent\n${"x".repeat(4000)}\n### Child\n${"y".repeat(200)}\n`;
    const node = buildChapterIndexNode(makeInput({ body }));
    const parent = node.sections?.[0];
    expect(parent?.heading_path).toEqual(["Parent"]);
    expect(parent?.sections?.[0]?.heading_path).toEqual(["Parent", "Child"]);
  });

  test("a section never carries when_to_use/not_for/summary fields — only chapters route", () => {
    const body = `## Section\n${"x".repeat(4000)}\n`;
    const node = buildChapterIndexNode(makeInput({ body }));
    const section = node.sections?.[0];
    expect(section).toBeDefined();
    expect(section).not.toHaveProperty("when_to_use");
    expect(section).not.toHaveProperty("not_for");
    expect(section).not.toHaveProperty("summary");
  });
});

describe("buildChapterIndexNode — hashing", () => {
  test("reformatting whitespace does not change content_hash or subtree_hash", () => {
    const body = `## Section\n${"x".repeat(4000)}   \n\n\n\nmore text\n`;
    const reformatted = `## Section\n${"x".repeat(4000)}\n\nmore text\n`;
    const a = buildChapterIndexNode(makeInput({ body }));
    const b = buildChapterIndexNode(makeInput({ body: reformatted }));
    expect(a.content_hash).toBe(b.content_hash);
    expect(a.subtree_hash).toBe(b.subtree_hash);
  });

  test("editing a section's content changes the chapter's subtree_hash but not necessarily content_hash", () => {
    const before = `## Section\n${"x".repeat(4000)}\n`;
    const after = `## Section\n${"y".repeat(4000)}\n`;
    const a = buildChapterIndexNode(makeInput({ body: before }));
    const b = buildChapterIndexNode(makeInput({ body: after }));
    // Chapter has no own text outside the section here, so content_hash
    // (own text only) is identical; subtree_hash (rolls up children) differs.
    expect(a.content_hash).toBe(b.content_hash);
    expect(a.subtree_hash).not.toBe(b.subtree_hash);
  });
});
