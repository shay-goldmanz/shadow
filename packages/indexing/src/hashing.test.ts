import { describe, expect, test } from "bun:test";
import { toBytes } from "./byte-text.ts";
import {
  computeContentHash,
  computeCorpusHash,
  computeSubtreeHash,
  computeVolumeHash,
  formatHash,
  ownText,
} from "./hashing.ts";

describe("computeContentHash", () => {
  test("is deterministic", () => {
    expect(computeContentHash("hello world")).toBe(computeContentHash("hello world"));
  });

  test("is formatted as sha256:<hex>", () => {
    expect(computeContentHash("x")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("reformatting whitespace does NOT change the hash (normalization applied before hashing)", () => {
    const original = "Some prose.   \n\nMore prose.\n";
    const reformatted = "Some prose.\n\n\n\n\nMore prose.\n"; // trailing space gone, blank run grown
    expect(computeContentHash(original)).toBe(computeContentHash(reformatted));
  });

  test("a real content edit DOES change the hash", () => {
    const before = "The sky is blue.\n";
    const after = "The sky is green.\n";
    expect(computeContentHash(before)).not.toBe(computeContentHash(after));
  });
});

describe("ownText", () => {
  test("with no children, own text is the whole span", () => {
    const bytes = toBytes("hello world");
    expect(ownText(bytes, { start_byte: 0, end_byte: 11 }, [])).toBe("hello world");
  });

  test("excludes a single child span from the middle", () => {
    const bytes = toBytes("AAABBBCCC");
    const text = ownText(bytes, { start_byte: 0, end_byte: 9 }, [{ start_byte: 3, end_byte: 6 }]);
    expect(text).toBe("AAACCC");
  });

  test("excludes multiple, out-of-order child spans", () => {
    const bytes = toBytes("0123456789");
    const text = ownText(bytes, { start_byte: 0, end_byte: 10 }, [
      { start_byte: 6, end_byte: 8 },
      { start_byte: 2, end_byte: 4 },
    ]);
    expect(text).toBe("014589");
  });
});

function corpusHashForLeaf(leafText: string): string {
  const leafHash = computeSubtreeHash(computeContentHash(leafText), []);
  const chapter1Hash = computeSubtreeHash(computeContentHash("chapter 1 own text"), [leafHash]);
  const chapter2Hash = computeSubtreeHash(computeContentHash("chapter 2 own text"), []);
  const volume1Hash = computeVolumeHash([chapter1Hash, chapter2Hash]);
  const volume2Hash = computeVolumeHash([computeSubtreeHash(computeContentHash("v2 chapter"), [])]);
  return computeCorpusHash([volume1Hash, volume2Hash]);
}

describe("computeSubtreeHash / rollups", () => {
  test("a leaf's subtree_hash is a function of its content_hash alone (no children)", () => {
    const contentHash = computeContentHash("leaf text");
    const subtreeHash = computeSubtreeHash(contentHash, []);
    expect(subtreeHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // subtree_hash still differs from content_hash (it's hashed again, not passed through).
    expect(subtreeHash).not.toBe(contentHash);
  });

  test("subtree_hash changes when a child's subtree_hash changes, even if own content_hash is unchanged", () => {
    const contentHash = computeContentHash("parent's own text");
    const childBefore = computeSubtreeHash(computeContentHash("child v1"), []);
    const childAfter = computeSubtreeHash(computeContentHash("child v2"), []);

    const parentBefore = computeSubtreeHash(contentHash, [childBefore]);
    const parentAfter = computeSubtreeHash(contentHash, [childAfter]);
    expect(parentBefore).not.toBe(parentAfter);
  });

  test("subtree_hash is order-sensitive over children", () => {
    const a = computeSubtreeHash(computeContentHash("a"), []);
    const b = computeSubtreeHash(computeContentHash("b"), []);
    expect(computeSubtreeHash(computeContentHash("parent"), [a, b])).not.toBe(
      computeSubtreeHash(computeContentHash("parent"), [b, a]),
    );
  });

  test("an edit anywhere in a subtree propagates all the way to volume_hash and corpus_hash", () => {
    // Build a tiny two-volume, two-chapter-each corpus and change one leaf.
    expect(corpusHashForLeaf("original section text")).not.toBe(
      corpusHashForLeaf("edited section text"),
    );
  });

  test("volume_hash and corpus_hash are stable (deterministic) for the same input", () => {
    const h1 = computeVolumeHash(["sha256:aa", "sha256:bb"]);
    const h2 = computeVolumeHash(["sha256:aa", "sha256:bb"]);
    expect(h1).toBe(h2);
    expect(computeCorpusHash([h1])).toBe(computeCorpusHash([h2]));
  });
});

describe("formatHash", () => {
  test("prefixes a raw hex digest", () => {
    expect(formatHash("deadbeef")).toBe("sha256:deadbeef");
  });
});
