import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemVolumeStore, toChapterSlug, toVolumeSlug, type VolumeStore } from "@shadow/core";
import { FakeStructuredGenerationPort } from "@shadow/model";
import { StructuralIndexer } from "./indexer.ts";
import { checkContradiction } from "./lint-contradiction.ts";
import type { IndexDocument } from "./types.ts";

async function withStore(fn: (store: VolumeStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shadow-lint-contradiction-test-"));
  try {
    await fn(new FileSystemVolumeStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function buildFixture(store: VolumeStore, root: string): Promise<IndexDocument> {
  const volume = toVolumeSlug("state-management");
  await store.createVolume({ slug: volume, title: "State management" });

  await store.putChapter(volume, {
    slug: toChapterSlug("use-redux"),
    title: "Use Redux for shared state",
    body: "Centralize shared application state in a single Redux store; never duplicate it in component state.\n",
    frontmatter: {
      when_to_use: "Managing shared state across many components in a large app.",
      not_for: "single-component local state",
      keywords: ["redux", "state"],
    },
  });

  await store.putChapter(volume, {
    slug: toChapterSlug("avoid-redux"),
    title: "Avoid Redux, prefer component state",
    body: "Keep state local to components with useState; a global store adds indirection most apps never need.\n",
    frontmatter: {
      when_to_use: "Managing shared state across many components in a large app.",
      not_for: "single-component local state",
      keywords: ["state", "hooks"],
    },
  });

  await store.putChapter(volume, {
    slug: toChapterSlug("onboarding-copy"),
    title: "Writing onboarding copy",
    body: "Keep onboarding copy warm and short.\n",
    frontmatter: {
      when_to_use: "Writing onboarding screen copy.",
      not_for: "error messages",
      keywords: ["copy", "onboarding"],
    },
  });

  const indexer = new StructuralIndexer({ rootDir: root });
  const { document } = await indexer.build(store);
  return document;
}

describe("checkContradiction", () => {
  test("overlapping when_to_use + conflicting guidance is flagged, driven by a scripted fake", async () => {
    await withStore(async (store, root) => {
      const document = await buildFixture(store, root);
      const chapters = document.volumes[0]?.chapters ?? [];
      const useRedux = chapters.find((c) => c.slug === "use-redux");
      const avoidRedux = chapters.find((c) => c.slug === "avoid-redux");
      if (!useRedux || !avoidRedux) {
        throw new Error("unreachable");
      }

      const port = new FakeStructuredGenerationPort([
        { conflicting: true, reason: "one recommends Redux, the other recommends avoiding it" },
      ]);

      const result = await checkContradiction(document, store, port);

      expect(result.checkId).toBe("contradiction");
      expect(result.requiresModel).toBe(true);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.code).toBe("contradiction");
      expect(result.findings[0]?.severity).toBe("warning");
      expect((result.findings[0]?.nodeIds ?? []).toSorted()).toEqual(
        [useRedux.node_id, avoidRedux.node_id].toSorted(),
      );
      expect(port.calls).toHaveLength(1); // the third chapter's when_to_use never overlaps, so no judge call for it
    });
  });

  test("overlapping when_to_use judged as non-conflicting is not flagged", async () => {
    await withStore(async (store, root) => {
      const document = await buildFixture(store, root);

      const port = new FakeStructuredGenerationPort([
        { conflicting: false, reason: "both address the same situation but are complementary" },
      ]);

      const result = await checkContradiction(document, store, port);

      expect(result.findings).toHaveLength(0);
      expect(port.calls).toHaveLength(1);
    });
  });

  test("a pair already reconciled via supersedes is skipped without a judge call", async () => {
    await withStore(async (store, root) => {
      const document = await buildFixture(store, root);
      const useRedux = document.volumes[0]?.chapters.find((c) => c.slug === "use-redux");
      if (!useRedux) {
        throw new Error("unreachable");
      }
      // Mark "avoid-redux" as superseding "use-redux", as D14 prescribes
      // for resolving a contradiction, then re-index with that frontmatter
      // present.
      await store.putChapter(toVolumeSlug("state-management"), {
        slug: toChapterSlug("avoid-redux"),
        title: "Avoid Redux, prefer component state",
        body: "Keep state local to components with useState; a global store adds indirection most apps never need.\n",
        frontmatter: {
          when_to_use: "Managing shared state across many components in a large app.",
          not_for: "single-component local state",
          keywords: ["state", "hooks"],
          supersedes: [useRedux.node_id],
        },
      });
      const indexer = new StructuralIndexer({ rootDir: root });
      const { document: reindexed } = await indexer.build(store);

      const port = new FakeStructuredGenerationPort([]);
      const result = await checkContradiction(reindexed, store, port);

      expect(result.findings).toHaveLength(0);
      expect(port.calls).toHaveLength(0);
    });
  });

  test("overlap threshold is configurable", async () => {
    await withStore(async (store, root) => {
      const document = await buildFixture(store, root);

      // Threshold of 1.1 is unreachable (jaccard maxes at 1) -> no pair
      // ever clears it, so no judge call happens at all.
      const port = new FakeStructuredGenerationPort([]);
      const result = await checkContradiction(document, store, port, { overlapThreshold: 1.1 });

      expect(result.findings).toHaveLength(0);
      expect(port.calls).toHaveLength(0);
    });
  });
});
