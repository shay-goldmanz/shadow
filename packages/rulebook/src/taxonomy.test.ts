import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemRulebookStore, toVolumeSlug, type VolumeSlug } from "@shadow/core";
import { FakeStructuredGenerationPort } from "@shadow/model";
import type { DocumentChunk } from "./chunker.ts";
import { GENERAL_GROUP_SLUG, planTaxonomy } from "./taxonomy.ts";

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "shadow-rulebook-taxonomy-test-"));
}

async function makeRulebookStore(
  slugName: string,
): Promise<{ root: string; rulebookStore: FileSystemRulebookStore; slug: VolumeSlug }> {
  const root = await makeTempRoot();
  const rulebookStore = new FileSystemRulebookStore(root);
  const slug = toVolumeSlug(slugName);
  await rulebookStore.createRulebook({ slug, title: "Taxonomy Test" });
  return { root, rulebookStore, slug };
}

function makeChunk(overrides: Partial<DocumentChunk> = {}): DocumentChunk {
  return {
    index: 0,
    headingPath: ["Loan Policy"],
    text: "Borrowers must repay principal and interest on time.",
    tokens: 10,
    contentHash: "a".repeat(64),
    ...overrides,
  };
}

const FIXTURE_TAXONOMY = {
  groups: [
    {
      slug: "repayment",
      title: "Repayment",
      when_to_use: "Rules about repaying principal and interest.",
      not_for: "Rules about loan origination.",
      keywords: ["repay", "interest"],
    },
  ],
};

describe("planTaxonomy", () => {
  test("plans a taxonomy on a cache miss and appends the reserved general group", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("taxonomy-miss");
    try {
      const structuredGeneration = new FakeStructuredGenerationPort([FIXTURE_TAXONOMY]);

      const result = await planTaxonomy(
        { structuredGeneration, rulebookStore },
        { rulebookSlug: slug, chunks: [makeChunk()], snapshotSha256: "b".repeat(64) },
      );

      expect(result.cached).toBe(false);
      expect(result.groups.map((g) => g.slug)).toEqual(["repayment", GENERAL_GROUP_SLUG]);
      expect(structuredGeneration.calls).toHaveLength(1);
      expect(structuredGeneration.calls[0]?.schemaName).toBe("rulebook-taxonomy");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not append a second general group if the LLM already proposed one", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("taxonomy-has-general");
    try {
      const withGeneral = {
        groups: [
          ...FIXTURE_TAXONOMY.groups,
          {
            slug: GENERAL_GROUP_SLUG,
            title: "General",
            when_to_use: "Anything that doesn't fit elsewhere.",
            not_for: "Nothing in particular.",
            keywords: [],
          },
        ],
      };
      const structuredGeneration = new FakeStructuredGenerationPort([withGeneral]);

      const result = await planTaxonomy(
        { structuredGeneration, rulebookStore },
        { rulebookSlug: slug, chunks: [makeChunk()], snapshotSha256: "c".repeat(64) },
      );

      expect(result.groups.filter((g) => g.slug === GENERAL_GROUP_SLUG)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a second call for the same snapshot hash hits the cache and skips the port", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("taxonomy-cache-hit");
    try {
      const structuredGeneration = new FakeStructuredGenerationPort([FIXTURE_TAXONOMY]);
      const args = { rulebookSlug: slug, chunks: [makeChunk()], snapshotSha256: "d".repeat(64) };

      const first = await planTaxonomy({ structuredGeneration, rulebookStore }, args);
      expect(first.cached).toBe(false);

      const second = await planTaxonomy({ structuredGeneration, rulebookStore }, args);
      expect(second.cached).toBe(true);
      expect(second.groups).toEqual(first.groups);
      expect(structuredGeneration.calls).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a different scope for the same snapshot hash is a cache miss, not a stale hit", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("taxonomy-scope-miss");
    try {
      const structuredGeneration = new FakeStructuredGenerationPort([
        FIXTURE_TAXONOMY,
        FIXTURE_TAXONOMY,
      ]);
      const snapshotSha256 = "f".repeat(64);

      const first = await planTaxonomy(
        { structuredGeneration, rulebookStore },
        { rulebookSlug: slug, chunks: [makeChunk()], snapshotSha256, scope: "focus on repayment" },
      );
      expect(first.cached).toBe(false);

      const second = await planTaxonomy(
        { structuredGeneration, rulebookStore },
        { rulebookSlug: slug, chunks: [makeChunk()], snapshotSha256, scope: "focus on collateral" },
      );
      expect(second.cached).toBe(false);
      expect(structuredGeneration.calls).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a different maxGroups for the same snapshot hash is a cache miss, not a stale hit", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("taxonomy-maxgroups-miss");
    try {
      const structuredGeneration = new FakeStructuredGenerationPort([
        FIXTURE_TAXONOMY,
        FIXTURE_TAXONOMY,
      ]);
      const snapshotSha256 = "1".repeat(64);

      const first = await planTaxonomy(
        { structuredGeneration, rulebookStore },
        { rulebookSlug: slug, chunks: [makeChunk()], snapshotSha256, maxGroups: 8 },
      );
      expect(first.cached).toBe(false);

      const second = await planTaxonomy(
        { structuredGeneration, rulebookStore },
        { rulebookSlug: slug, chunks: [makeChunk()], snapshotSha256, maxGroups: 12 },
      );
      expect(second.cached).toBe(false);
      expect(structuredGeneration.calls).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("evenly truncates an oversized outline and notes the truncation in the prompt", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("taxonomy-truncate");
    try {
      const manyChunks = Array.from({ length: 500 }, (_, i) =>
        makeChunk({
          index: i,
          text: `Section ${i} discusses a distinct topic in detail. `.repeat(20),
          contentHash: `${i}`.padStart(64, "0"),
        }),
      );
      let capturedPrompt = "";
      const structuredGeneration = new FakeStructuredGenerationPort((request) => {
        capturedPrompt = request.prompt;
        return FIXTURE_TAXONOMY;
      });

      await planTaxonomy(
        { structuredGeneration, rulebookStore },
        { rulebookSlug: slug, chunks: manyChunks, snapshotSha256: "e".repeat(64) },
      );

      expect(capturedPrompt).toContain("truncated");
      // The full untruncated outline for 500 chunks like this would run well
      // past 100k chars; confirm the cap actually bit.
      expect(capturedPrompt.length).toBeLessThan(40_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
