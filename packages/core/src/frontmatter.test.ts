import { describe, expect, test } from "bun:test";
import { ChapterParseError, VolumeParseError } from "./errors.ts";
import { parseChapterDocument, serializeChapterDocument } from "./frontmatter.ts";
import { toChapterSlug, toVolumeSlug } from "./slug.ts";
import type { OkfStatus } from "./types.ts";
import { parseVolumeDocument } from "./volume-frontmatter.ts";

const slug = toChapterSlug("chapter-one");

type ChapterDoc = Parameters<typeof serializeChapterDocument>[0];

function mkChapter(
  overrides: Partial<ChapterDoc> & Pick<ChapterDoc, "title" | "body">,
): ChapterDoc {
  return {
    type: "Concept",
    status: "draft" as OkfStatus,
    staleAfter: null,
    generated: { by: "test", at: new Date("2026-01-01T00:00:00.000Z") },
    verified: [],
    frontmatter: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function roundTrip(chapter: ChapterDoc) {
  const document = serializeChapterDocument(chapter);
  return { document, parsed: parseChapterDocument(slug, document) };
}

describe("serializeChapterDocument / parseChapterDocument", () => {
  test("round-trips title, timestamps, and a plain body", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const updatedAt = new Date("2026-01-02T00:00:00.000Z");
    const { parsed } = roundTrip(
      mkChapter({
        title: "Designing One-Pagers",
        body: "Some body text.\n",
        createdAt,
        updatedAt,
      }),
    );

    expect(parsed.title).toBe("Designing One-Pagers");
    expect(parsed.body).toBe("Some body text.\n");
    expect(parsed.createdAt.getTime()).toBe(createdAt.getTime());
    expect(parsed.updatedAt.getTime()).toBe(updatedAt.getTime());
    expect(parsed.frontmatter).toEqual({});
  });

  test("round-trips OKF typed fields", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const updatedAt = new Date("2026-01-02T00:00:00.000Z");
    const generatedAt = new Date("2026-01-01T12:00:00.000Z");
    const verifiedAt = new Date("2026-01-03T00:00:00.000Z");
    const staleAfter = new Date("2026-09-23");

    const { parsed } = roundTrip({
      title: "Designing One-Pagers",
      type: "Design Guidance",
      status: "stable",
      staleAfter,
      generated: { by: "shadow/1.0", at: generatedAt },
      verified: [{ by: "human:alice", at: verifiedAt }],
      body: "Some body text.\n",
      frontmatter: {},
      createdAt,
      updatedAt,
    });

    expect(parsed.type).toBe("Design Guidance");
    expect(parsed.status).toBe("stable");
    expect(parsed.staleAfter?.getTime()).toBe(staleAfter.getTime());
    expect(parsed.generated.by).toBe("shadow/1.0");
    expect(parsed.generated.at.getTime()).toBe(generatedAt.getTime());
    expect(parsed.verified).toHaveLength(1);
    expect(parsed.verified[0]!.by).toBe("human:alice");
    expect(parsed.verified[0]!.at.getTime()).toBe(verifiedAt.getTime());
  });

  test("OKF fields default gracefully when absent from YAML", () => {
    const raw = [
      "---",
      "title: T",
      "type: Reference",
      "createdAt: 2026-01-01T00:00:00.000Z",
      "updatedAt: 2026-01-01T00:00:00.000Z",
      "---",
      "body",
    ].join("\n");

    const parsed = parseChapterDocument(slug, raw);
    expect(parsed.type).toBe("Reference");
    expect(parsed.status).toBe("draft"); // default
    expect(parsed.staleAfter).toBeNull();
    expect(parsed.generated.by).toBe("unknown"); // default
    expect(parsed.verified).toEqual([]);
  });

  test("OKF verified accepts single mapping (OKF §5.2)", () => {
    const raw = [
      "---",
      "title: T",
      "type: Reference",
      "createdAt: 2026-01-01T00:00:00.000Z",
      "updatedAt: 2026-01-01T00:00:00.000Z",
      "verified:",
      "  by: human:alice",
      "  at: 2026-06-25T09:00:00Z",
      "---",
      "body",
    ].join("\n");

    const parsed = parseChapterDocument(slug, raw);
    expect(parsed.verified).toHaveLength(1);
    expect(parsed.verified[0]!.by).toBe("human:alice");
  });

  test("round-trips a multi-line body with special characters exactly, including an embedded '---'", () => {
    const body = [
      "# Heading",
      "",
      "Quotes: \"double\" and 'single', a colon: like this, an em dash — here.",
      "Unicode: 日本語, emoji: 🎉.",
      "",
      "---",
      "",
      "A horizontal rule above, and trailing whitespace below.   ",
      "\tA tab-indented line.",
      "",
    ].join("\n");

    const { parsed } = roundTrip(
      mkChapter({
        title: "T",
        body,
      }),
    );

    expect(parsed.body).toBe(body);
  });

  test("round-trips unknown, nested, and array frontmatter keys, preserving key order", () => {
    const frontmatter = {
      when_to_use: ["designing a one-pager", "single-page layout"],
      not_for: ["multi-page documents"],
      nested: { weight: 0.8, tags: ["a", "b"] },
      custom_z: "last",
      custom_a: "first-ish",
      null_field: null,
      bool_field: true,
      num_field: 3.14,
    };

    const { parsed } = roundTrip(
      mkChapter({
        title: "T",
        body: "body",
        frontmatter,
      }),
    );

    expect(parsed.frontmatter).toEqual(frontmatter);
    expect(Object.keys(parsed.frontmatter)).toEqual(Object.keys(frontmatter));
  });

  test("frontmatter never leaks the reserved title/createdAt/updatedAt keys back into the open record", () => {
    const { parsed } = roundTrip(
      mkChapter({
        title: "T",
        body: "body",
        frontmatter: { custom: 1 },
      }),
    );
    expect(parsed.frontmatter).not.toHaveProperty("title");
    expect(parsed.frontmatter).not.toHaveProperty("createdAt");
    expect(parsed.frontmatter).not.toHaveProperty("updatedAt");
    // OKF fields must also never leak into frontmatter
    expect(parsed.frontmatter).not.toHaveProperty("type");
    expect(parsed.frontmatter).not.toHaveProperty("status");
    expect(parsed.frontmatter).not.toHaveProperty("stale_after");
    expect(parsed.frontmatter).not.toHaveProperty("generated");
    expect(parsed.frontmatter).not.toHaveProperty("verified");
  });

  test("empty body round-trips as an empty string", () => {
    const { parsed } = roundTrip(
      mkChapter({
        title: "T",
        body: "",
      }),
    );
    expect(parsed.body).toBe("");
  });

  test("parseChapterDocument rejects a document with no frontmatter block", () => {
    expect(() => parseChapterDocument(slug, "# Just a heading\n\nNo frontmatter here.\n")).toThrow(
      ChapterParseError,
    );
  });

  test("parseChapterDocument rejects invalid YAML in the frontmatter block", () => {
    const broken = "---\ntitle: [unterminated\n---\nbody\n";
    expect(() => parseChapterDocument(slug, broken)).toThrow(ChapterParseError);
  });

  test("parseChapterDocument rejects frontmatter missing required fields", () => {
    const missingTitle =
      "---\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\nbody\n";
    expect(() => parseChapterDocument(slug, missingTitle)).toThrow(ChapterParseError);
  });

  test("parseChapterDocument rejects frontmatter missing type field", () => {
    const missingType =
      "---\ntitle: T\ncreatedAt: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-01-01T00:00:00.000Z\n---\nbody\n";
    expect(() => parseChapterDocument(slug, missingType)).toThrow(ChapterParseError);
  });

  test("an empty frontmatter block (fences with nothing between them) is syntactically valid delimiting, but still rejected for missing required fields", () => {
    let error: unknown;
    try {
      parseChapterDocument(slug, "---\n---\nbody");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChapterParseError);
    expect((error as ChapterParseError).reason).toContain("must be a mapping");
    expect((error as ChapterParseError).reason).not.toContain("missing YAML frontmatter");
  });
});

describe("parseVolumeDocument shares the same empty-frontmatter-block fix", () => {
  test("an empty frontmatter block is syntactically valid delimiting, but still rejected for missing required fields", () => {
    const volumeSlug = toVolumeSlug("vol-one");
    let error: unknown;
    try {
      parseVolumeDocument(volumeSlug, "---\n---\ndescription");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(VolumeParseError);
    expect((error as VolumeParseError).reason).toContain("must be a mapping");
    expect((error as VolumeParseError).reason).not.toContain("missing YAML frontmatter");
  });
});
