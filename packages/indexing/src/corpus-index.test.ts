import { describe, expect, test } from "bun:test";
import { buildChapterIndexNode } from "./chapter-index.ts";
import { buildIndexDocument } from "./corpus-index.ts";
import { computeCorpusHash } from "./hashing.ts";
import { INDEX_SCHEMA_VERSION } from "./types.ts";
import { buildVolumeIndexNode } from "./volume-index.ts";

function volume(slug: string) {
  const chapter = buildChapterIndexNode({
    ulid: `01${slug.toUpperCase()}`,
    volumeTitle: slug,
    chapterSlug: "c",
    chapterTitle: "C",
    body: "some prose\n",
    frontmatter: {},
    file: `volumes/${slug}/chapters/c.md`,
  });
  return buildVolumeIndexNode({
    volumeSlug: slug,
    volumeTitle: slug,
    whenToUse: undefined,
    notFor: undefined,
    keywords: undefined,
    chapters: [chapter],
  });
}

describe("buildIndexDocument", () => {
  test("sets schema_version and a fresh generated_at", () => {
    const before = new Date();
    const doc = buildIndexDocument([volume("a")]);
    expect(doc.schema_version).toBe(INDEX_SCHEMA_VERSION);
    expect(new Date(doc.generated_at).getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  test("stats aggregate volumes/chapters/tokens across the corpus", () => {
    const doc = buildIndexDocument([volume("a"), volume("b")]);
    expect(doc.stats.volumes).toBe(2);
    expect(doc.stats.chapters).toBe(2);
    expect(doc.stats.tokens).toBeGreaterThan(0);
  });

  test("corpus_hash = sha256(concat(volume_hashes, slug order))", () => {
    const volumes = [volume("a"), volume("b")];
    const doc = buildIndexDocument(volumes);
    expect(doc.corpus_hash).toBe(computeCorpusHash(volumes.map((v) => v.volume_hash)));
  });

  test("an accepted `generatedAt` override is used verbatim", () => {
    const fixed = new Date("2026-08-11T10:47:00.000Z");
    const doc = buildIndexDocument([volume("a")], fixed);
    expect(doc.generated_at).toBe("2026-08-11T10:47:00.000Z");
  });

  test("empty corpus produces a valid, empty document", () => {
    const doc = buildIndexDocument([]);
    expect(doc.stats).toEqual({ volumes: 0, chapters: 0, tokens: 0 });
    expect(doc.volumes).toEqual([]);
    expect(doc.corpus_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
