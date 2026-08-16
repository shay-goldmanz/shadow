import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chapter, Volume } from "@shadow/core";
import { toChapterSlug, toVolumeSlug } from "@shadow/core";
import { chapter, document, volume } from "./lint-fixtures.ts";
import {
  loadOkfBundleArtifacts,
  okfChapterRecordsFrom,
  okfVolumeRecordsFrom,
} from "./okf-input.ts";

function storeChapter(overrides: Partial<Omit<Chapter, "slug">> & { slug: string }): Chapter {
  return {
    title: overrides.slug,
    body: "# body\n",
    type: "Concept",
    status: "draft",
    staleAfter: null,
    generated: { by: "shadow/1.0", at: new Date("2026-01-02T03:04:05.000Z") },
    verified: [],
    frontmatter: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
    slug: toChapterSlug(overrides.slug),
  };
}

function storeVolume(overrides: Partial<Omit<Volume, "slug">> & { slug: string }): Volume {
  return {
    title: overrides.slug,
    description: "",
    type: "Concept",
    status: "draft",
    staleAfter: null,
    generated: { by: "shadow/1.0", at: new Date("2026-01-01T00:00:00.000Z") },
    verified: [],
    frontmatter: {},
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
    slug: toVolumeSlug(overrides.slug),
  };
}

describe("okfChapterRecordsFrom", () => {
  test("pulls identity fields from the index node and typed OKF fields from the matching Chapter, matched by slug", () => {
    const node = chapter({
      node_id: "A",
      title: "Alpha",
      slug: "alpha",
      type: "Design Guidance",
      attestedComputation: undefined,
    });
    const doc = document([volume({ volume_id: "v", chapters: [node] })]);

    const storeCh = storeChapter({
      slug: "alpha",
      status: "stable",
      staleAfter: new Date("2026-06-15T12:00:00.000Z"),
      generated: { by: "operator", at: new Date("2026-01-02T03:04:05.000Z") },
      verified: [{ by: "reviewer", at: new Date("2026-01-03T00:00:00.000Z") }],
    });

    const records = okfChapterRecordsFrom(doc, new Map([["v", [storeCh]]]));

    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.slug).toBe("alpha");
    expect(record.node_id).toBe("A"); // from the index node
    expect(record.title).toBe("Alpha"); // from the index node
    expect(record.type).toBe("Design Guidance"); // from the index node
    expect(record.status).toBe("stable"); // from the Chapter domain object
    expect(record.generated).toEqual({ by: "operator", at: "2026-01-02T03:04:05.000Z" });
    expect(record.stale_after).toBe("2026-06-15"); // Date -> YYYY-MM-DD
    expect(record.verified).toEqual([{ by: "reviewer", at: "2026-01-03T00:00:00.000Z" }]);
  });

  test("attestedComputation comes from the index node, not the store", () => {
    const ac = {
      runtime: "bigquery",
      parameters: [{ name: "year", type: "integer", required: true }],
      executor: { resource: "run.md", receipt: ["job_id"] },
      attester: { resource: "check.py" },
    };
    const node = chapter({
      node_id: "A",
      title: "Revenue",
      slug: "revenue",
      type: "Attested Computation",
      attestedComputation: ac,
    });
    const doc = document([volume({ volume_id: "v", chapters: [node] })]);
    const records = okfChapterRecordsFrom(
      doc,
      new Map([["v", [storeChapter({ slug: "revenue" })]]]),
    );

    expect(records[0]!.attestedComputation).toEqual(ac);
  });

  test("a chapter with no staleAfter omits stale_after", () => {
    const node = chapter({ node_id: "A", title: "Alpha", slug: "alpha" });
    const doc = document([volume({ volume_id: "v", chapters: [node] })]);
    const records = okfChapterRecordsFrom(
      doc,
      new Map([["v", [storeChapter({ slug: "alpha", staleAfter: null })]]]),
    );
    expect(records[0]!.stale_after).toBeUndefined();
  });

  test("a chapter node with no matching store chapter is skipped, defensively", () => {
    const node = chapter({ node_id: "A", title: "Alpha", slug: "alpha" });
    const doc = document([volume({ volume_id: "v", chapters: [node] })]);
    const records = okfChapterRecordsFrom(doc, new Map([["v", []]]));
    expect(records).toHaveLength(0);
  });

  test("a volume node with no entry in chaptersByVolume yields no records for that volume", () => {
    const node = chapter({ node_id: "A", title: "Alpha", slug: "alpha" });
    const doc = document([volume({ volume_id: "v", chapters: [node] })]);
    const records = okfChapterRecordsFrom(doc, new Map());
    expect(records).toHaveLength(0);
  });
});

describe("okfVolumeRecordsFrom", () => {
  test("pulls volume_id from the index node and title/type/typed OKF fields from the matching Volume", () => {
    const doc = document([
      volume({ volume_id: "ui-design", title: "Interface Design", chapters: [] }),
    ]);
    const storeVol = storeVolume({
      slug: "ui-design",
      title: "Interface Design",
      type: "Guidance",
      status: "stable",
      staleAfter: new Date("2026-06-15T12:00:00.000Z"),
      generated: { by: "operator", at: new Date("2026-01-02T03:04:05.000Z") },
      verified: [{ by: "reviewer", at: new Date("2026-01-03T00:00:00.000Z") }],
    });

    const records = okfVolumeRecordsFrom(doc, [storeVol]);

    expect(records).toEqual([
      {
        volume_id: "ui-design",
        title: "Interface Design",
        type: "Guidance",
        status: "stable",
        generated: { by: "operator", at: "2026-01-02T03:04:05.000Z" },
        verified: [{ by: "reviewer", at: "2026-01-03T00:00:00.000Z" }],
        stale_after: "2026-06-15",
      },
    ]);
  });

  test("a volume with no staleAfter omits stale_after", () => {
    const doc = document([volume({ volume_id: "ui-design", chapters: [] })]);
    const storeVol = storeVolume({ slug: "ui-design", staleAfter: null });

    const records = okfVolumeRecordsFrom(doc, [storeVol]);

    expect(records[0]!.stale_after).toBeUndefined();
  });

  test("a volume node with no matching Volume domain object is skipped", () => {
    const doc = document([volume({ volume_id: "ui-design", chapters: [] })]);
    const records = okfVolumeRecordsFrom(doc, []);
    expect(records).toHaveLength(0);
  });
});

describe("loadOkfBundleArtifacts", () => {
  async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "shadow-okf-input-test-"));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("both artifacts present and valid", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "index.md"), '---\nokf_version: "0.2"\n---\n\n# Volumes\n');
      await Bun.write(join(dir, "log.md"), "# Log\n");

      const artifacts = await loadOkfBundleArtifacts(dir);
      expect(artifacts).toEqual({ rootIndexOkfVersion: true, logExists: true });
    });
  });

  test("index.md exists but its frontmatter is missing okf_version", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "index.md"), "---\ntitle: Volumes\n---\n\n# Volumes\n");
      await Bun.write(join(dir, "log.md"), "# Log\n");

      const artifacts = await loadOkfBundleArtifacts(dir);
      expect(artifacts.rootIndexOkfVersion).toBe(false);
      expect(artifacts.logExists).toBe(true);
    });
  });

  test("index.md has no frontmatter block at all", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(join(dir, "index.md"), "# Volumes\n\nNo frontmatter here.\n");

      const artifacts = await loadOkfBundleArtifacts(dir);
      expect(artifacts.rootIndexOkfVersion).toBe(false);
    });
  });

  test("nothing on disk", async () => {
    await withTempDir(async (dir) => {
      const artifacts = await loadOkfBundleArtifacts(dir);
      expect(artifacts).toEqual({ rootIndexOkfVersion: false, logExists: false });
    });
  });
});
