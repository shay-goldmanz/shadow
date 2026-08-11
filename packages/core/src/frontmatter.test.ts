import { describe, expect, test } from "bun:test";
import { ChapterParseError, VolumeParseError } from "./errors.ts";
import { parseChapterDocument, serializeChapterDocument } from "./frontmatter.ts";
import { toChapterSlug, toVolumeSlug } from "./slug.ts";
import { parseVolumeDocument } from "./volume-frontmatter.ts";

const slug = toChapterSlug("chapter-one");

function roundTrip(chapter: Parameters<typeof serializeChapterDocument>[0]) {
  const document = serializeChapterDocument(chapter);
  return { document, parsed: parseChapterDocument(slug, document) };
}

describe("serializeChapterDocument / parseChapterDocument", () => {
  test("round-trips title, timestamps, and a plain body", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const updatedAt = new Date("2026-01-02T00:00:00.000Z");
    const { parsed } = roundTrip({
      title: "Designing One-Pagers",
      body: "Some body text.\n",
      frontmatter: {},
      createdAt,
      updatedAt,
    });

    expect(parsed.title).toBe("Designing One-Pagers");
    expect(parsed.body).toBe("Some body text.\n");
    expect(parsed.createdAt.getTime()).toBe(createdAt.getTime());
    expect(parsed.updatedAt.getTime()).toBe(updatedAt.getTime());
    expect(parsed.frontmatter).toEqual({});
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

    const { parsed } = roundTrip({
      title: "T",
      body,
      frontmatter: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

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

    const { parsed } = roundTrip({
      title: "T",
      body: "body",
      frontmatter,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(parsed.frontmatter).toEqual(frontmatter);
    expect(Object.keys(parsed.frontmatter)).toEqual(Object.keys(frontmatter));
  });

  test("frontmatter never leaks the reserved title/createdAt/updatedAt keys back into the open record", () => {
    const { parsed } = roundTrip({
      title: "T",
      body: "body",
      frontmatter: { custom: 1 },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(parsed.frontmatter).not.toHaveProperty("title");
    expect(parsed.frontmatter).not.toHaveProperty("createdAt");
    expect(parsed.frontmatter).not.toHaveProperty("updatedAt");
  });

  test("empty body round-trips as an empty string", () => {
    const { parsed } = roundTrip({
      title: "T",
      body: "",
      frontmatter: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
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

  test("an empty frontmatter block (fences with nothing between them) is syntactically valid delimiting, but still rejected for missing required fields", () => {
    // `---\n---\n` only ever occurs in a hand-edited file (D4) — this
    // package always writes at least `title`. Decision: don't accept it as
    // a valid Chapter (title/createdAt/updatedAt are still mandatory), but
    // the delimiter regex must recognize it as *present-but-empty*
    // frontmatter rather than misreporting "missing frontmatter block", so
    // the error an operator sees names the actual problem.
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

// `FRONTMATTER_PATTERN` (`frontmatter-shared.ts`) is shared verbatim between
// the chapter and volume document formats — confirm the empty-block fix
// applies to `parseVolumeDocument` too, not just its chapter counterpart.
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
