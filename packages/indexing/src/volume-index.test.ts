import { describe, expect, test } from "bun:test";
import { buildChapterIndexNode } from "./chapter-index.ts";
import { computeVolumeHash } from "./hashing.ts";
import { buildVolumeIndexNode } from "./volume-index.ts";

function chapter(slug: string, ulid: string, body = "prose\n") {
  return buildChapterIndexNode({
    ulid,
    volumeTitle: "Vol",
    chapterSlug: slug,
    chapterTitle: slug,
    body,
    frontmatter: {},
    file: `volumes/vol/chapters/${slug}.md`,
  });
}

describe("buildVolumeIndexNode", () => {
  test("assembles volume_id, title, chapter_count, and chapters verbatim", () => {
    const chapters = [chapter("a", "01A"), chapter("b", "01B")];
    const node = buildVolumeIndexNode({
      volumeSlug: "ui-design",
      volumeTitle: "Interface Design",
      whenToUse: "Designing UI",
      notFor: "brand identity",
      keywords: ["linear", "notion"],
      chapters,
    });
    expect(node.volume_id).toBe("ui-design");
    expect(node.title).toBe("Interface Design");
    expect(node.when_to_use).toBe("Designing UI");
    expect(node.not_for).toBe("brand identity");
    expect(node.keywords).toEqual(["linear", "notion"]);
    expect(node.chapter_count).toBe(2);
    expect(node.chapters).toBe(chapters);
  });

  test("volume_hash = sha256(concat(chapter subtree_hashes, slug order))", () => {
    const chapters = [chapter("a", "01A"), chapter("b", "01B")];
    const node = buildVolumeIndexNode({
      volumeSlug: "v",
      volumeTitle: "V",
      whenToUse: undefined,
      notFor: undefined,
      keywords: undefined,
      chapters,
    });
    expect(node.volume_hash).toBe(computeVolumeHash(chapters.map((c) => c.subtree_hash)));
  });

  test("volume_hash changes if a chapter's content changes", () => {
    const before = buildVolumeIndexNode({
      volumeSlug: "v",
      volumeTitle: "V",
      whenToUse: undefined,
      notFor: undefined,
      keywords: undefined,
      chapters: [chapter("a", "01A", "original text\n")],
    });
    const after = buildVolumeIndexNode({
      volumeSlug: "v",
      volumeTitle: "V",
      whenToUse: undefined,
      notFor: undefined,
      keywords: undefined,
      chapters: [chapter("a", "01A", "edited text\n")],
    });
    expect(before.volume_hash).not.toBe(after.volume_hash);
  });

  test("an empty chapter list still produces a deterministic volume_hash", () => {
    const node = buildVolumeIndexNode({
      volumeSlug: "empty",
      volumeTitle: "Empty",
      whenToUse: undefined,
      notFor: undefined,
      keywords: undefined,
      chapters: [],
    });
    expect(node.chapter_count).toBe(0);
    expect(node.volume_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
