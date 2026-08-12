/**
 * Unit tests for OKF `index.md` generation.
 */

import { describe, expect, test } from "bun:test";
import { generateRootIndexMd, generateVolumeIndexMd } from "./index-md.ts";
import type { ChapterIndexNode, VolumeIndexNode } from "./types.ts";

function chapter(data: Partial<ChapterIndexNode> = {}): ChapterIndexNode {
  return {
    node_id: data.node_id ?? "01JATEST0000000000000000001",
    kind: "chapter",
    title: data.title ?? "Test Chapter",
    slug: data.slug ?? "test-chapter",
    path: [data.path?.[0] ?? "Test Volume", data.title ?? "Test Chapter"],
    file: data.file ?? "volumes/test-volume/chapters/test-chapter.md",
    when_to_use: data.when_to_use,
    not_for: data.not_for,
    keywords: data.keywords,
    confidence: data.confidence,
    supersedes: data.supersedes,
    aliases: data.aliases,
    updated: data.updated,
    tokens: data.tokens ?? 100,
    span: data.span ?? { start_byte: 0, end_byte: 500 },
    content_hash:
      data.content_hash ??
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    subtree_hash:
      data.subtree_hash ??
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sections: data.sections,
    key_items: data.key_items,
  };
}

function volume(data: Partial<VolumeIndexNode> = {}): VolumeIndexNode {
  return {
    volume_id: data.volume_id ?? "test-volume",
    title: data.title ?? "Test Volume",
    when_to_use: data.when_to_use,
    not_for: data.not_for,
    keywords: data.keywords,
    chapter_count: data.chapter_count ?? 0,
    volume_hash:
      data.volume_hash ?? "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    chapters: data.chapters ?? [],
  };
}

describe("generateVolumeIndexMd", () => {
  test("an empty volume produces the empty state", () => {
    const v = volume({ chapters: [] });
    const md = generateVolumeIndexMd(v);
    expect(md).toContain("# Test Volume");
    expect(md).toContain("_No chapters yet._");
    expect(md).not.toContain("---"); // no frontmatter on per-volume index.md
  });

  test("lists chapters with descriptions derived from when_to_use", () => {
    const v = volume({
      chapters: [
        chapter({
          title: "Design Density",
          slug: "design-density",
          when_to_use: "When designing dense UIs.",
        }),
        chapter({
          title: "One-Pager Format",
          slug: "one-pager",
          when_to_use: "Writing single-page documents.",
        }),
      ],
    });
    const md = generateVolumeIndexMd(v);
    expect(md).toContain("[Design Density](chapters/design-density.md)");
    expect(md).toContain("When designing dense UIs.");
    expect(md).toContain("[One-Pager Format](chapters/one-pager.md)");
    expect(md).toContain("Writing single-page documents.");
  });

  test("includes confidence in the description when present", () => {
    const v = volume({
      chapters: [chapter({ title: "A", slug: "a", when_to_use: "Always.", confidence: "high" })],
    });
    const md = generateVolumeIndexMd(v);
    expect(md).toContain("[high]");
  });

  test("omits description when when_to_use is absent", () => {
    const v = volume({
      chapters: [chapter({ title: "Plain", slug: "plain" })],
    });
    const md = generateVolumeIndexMd(v);
    // Should have just the title without " — "
    expect(md).toContain("[Plain](chapters/plain.md)\n");
  });

  test("renders volume when_to_use and not_for", () => {
    const v = volume({
      when_to_use: "Designing UI components.",
      not_for: "Backend architecture.",
    });
    const md = generateVolumeIndexMd(v);
    expect(md).toContain("Designing UI components.");
    expect(md).toContain("_Not for: Backend architecture._");
  });

  test("truncates long when_to_use descriptions", () => {
    const long = "A".repeat(200);
    const v = volume({
      chapters: [chapter({ title: "Long", slug: "long", when_to_use: long })],
    });
    const md = generateVolumeIndexMd(v);
    expect(md).toContain("…");
  });
});

describe("generateRootIndexMd", () => {
  test("carries okf_version frontmatter", () => {
    const md = generateRootIndexMd([]);
    expect(md).toContain('okf_version: "0.2"');
    expect(md).toContain("---"); // has frontmatter fences
  });

  test("lists multiple volumes", () => {
    const v1 = volume({
      volume_id: "ui",
      title: "Interface Design",
      chapters: [chapter({ title: "Density", slug: "density" })],
    });
    const v2 = volume({
      volume_id: "writing",
      title: "Writing",
      chapters: [chapter({ title: "One-Pager", slug: "one-pager" })],
    });
    const md = generateRootIndexMd([v1, v2]);

    expect(md).toContain("## Interface Design");
    expect(md).toContain("## Writing");
    expect(md).toContain("[Density](chapters/density.md)");
    expect(md).toContain("[One-Pager](chapters/one-pager.md)");
  });

  test("empty volumes render the empty state", () => {
    const v = volume({ chapters: [] });
    const md = generateRootIndexMd([v]);
    expect(md).toContain("_No chapters yet._");
  });

  test("no volumes produces just a heading", () => {
    const md = generateRootIndexMd([]);
    expect(md).toContain("# Volumes");
    expect(md).not.toContain("##");
  });
});
