import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemVolumeStore, toChapterSlug, toVolumeSlug, type VolumeStore } from "@shadow/core";
import { FakeStructuredGenerationPort } from "@shadow/model";
import { StructuralIndexer } from "./indexer.ts";
import { InMemoryMissLog } from "./lint-miss-log.ts";
import { checkSelfRetrieval } from "./lint-self-retrieval.ts";
import type { IndexDocument } from "./types.ts";

async function withStore(fn: (store: VolumeStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shadow-lint-self-retrieval-test-"));
  try {
    await fn(new FileSystemVolumeStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Two real, indexed chapters — the same fixture shape `navigator.test.ts` uses (T2.3's own precedent), reused because self-retrieval genuinely drives `ReasoningNavigator` end to end and needs real chapter bodies for its BM25-fallback/disagreement path. */
async function buildTwoChapterFixture(store: VolumeStore): Promise<IndexDocument> {
  const volume = toVolumeSlug("ui-design");
  await store.createVolume({ slug: volume, title: "Interface Design" });

  await store.putChapter(volume, {
    slug: toChapterSlug("linear-density"),
    title: "How Linear handles information density",
    body: "Linear renders table rows at a tight 32px height and truncates labels aggressively.\n",
    frontmatter: {
      when_to_use: "Designing dense tables, lists, and dashboards.",
      not_for: "onboarding flows",
      keywords: ["density", "linear", "row height"],
    },
  });

  await store.putChapter(volume, {
    slug: toChapterSlug("onboarding"),
    title: "Warm onboarding flows",
    body: "Welcome screens should feel warm, spacious, and low-friction for first-time users.\n",
    frontmatter: {
      when_to_use: "Designing onboarding and empty states.",
      not_for: "dense data tables",
      keywords: ["onboarding", "welcome", "empty state"],
    },
  });

  const indexer = new StructuralIndexer();
  const { document } = await indexer.build(store);
  return document;
}

async function buildOneChapterFixture(store: VolumeStore): Promise<IndexDocument> {
  const volume = toVolumeSlug("ui-design");
  await store.createVolume({ slug: volume, title: "Interface Design" });

  await store.putChapter(volume, {
    slug: toChapterSlug("linear-density"),
    title: "How Linear handles information density",
    body: "Linear renders table rows at a tight 32px height and truncates labels aggressively.\n",
    frontmatter: {
      when_to_use: "Designing dense tables, lists, and dashboards.",
      not_for: "onboarding flows",
      keywords: ["density", "linear", "row height"],
    },
  });

  const indexer = new StructuralIndexer();
  const { document } = await indexer.build(store);
  return document;
}

describe("checkSelfRetrieval", () => {
  test("a chapter with a good when_to_use retrieves itself", async () => {
    await withStore(async (store) => {
      const document = await buildTwoChapterFixture(store);
      const density = document.volumes[0]?.chapters.find((c) => c.slug === "linear-density");
      const onboarding = document.volumes[0]?.chapters.find((c) => c.slug === "onboarding");
      if (!density || !onboarding) {
        throw new Error("unreachable");
      }

      const port = new FakeStructuredGenerationPort([
        // probe 1: density — retrieves itself
        { task: "how do I keep a dense table readable" },
        { chosen: [density.node_id], rejected: [] },
        { verdict: "sufficient" },
        // probe 2: onboarding — retrieves itself
        { task: "how do I design a warm onboarding flow" },
        { chosen: [onboarding.node_id], rejected: [] },
        { verdict: "sufficient" },
      ]);

      const { result, probes, coverage } = await checkSelfRetrieval(document, store, port);

      expect(result.checkId).toBe("self-retrieval");
      expect(result.requiresModel).toBe(true);
      expect(result.findings).toHaveLength(0);
      expect(probes).toHaveLength(2);
      expect(probes.every((p) => p.retrievedSelf)).toBe(true);
      expect(coverage.has(density.node_id)).toBe(true);
      expect(coverage.has(onboarding.node_id)).toBe(true);
      // every call actually went through the port
      expect(port.calls.length).toBe(6);
    });
  });

  test("a chapter with a vague/wrong when_to_use does not retrieve itself, and is reported", async () => {
    await withStore(async (store) => {
      const document = await buildTwoChapterFixture(store);
      const density = document.volumes[0]?.chapters.find((c) => c.slug === "linear-density");
      const onboarding = document.volumes[0]?.chapters.find((c) => c.slug === "onboarding");
      if (!density || !onboarding) {
        throw new Error("unreachable");
      }

      const port = new FakeStructuredGenerationPort([
        // probe 1: density — retrieves itself correctly
        { task: "how do I keep a dense table readable" },
        { chosen: [density.node_id], rejected: [] },
        { verdict: "sufficient" },
        // probe 2: onboarding's own probe is routed (wrongly) to density
        // instead — simulating a vague/overlapping when_to_use.
        { task: "a vague onboarding-shaped task" },
        {
          chosen: [density.node_id],
          rejected: [{ node_id: onboarding.node_id, why: "not_for seemed to exclude it" }],
        },
        { verdict: "sufficient" },
      ]);
      const missLog = new InMemoryMissLog();

      const { result, probes } = await checkSelfRetrieval(document, store, port, { missLog });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.code).toBe("self-retrieval-miss");
      expect(result.findings[0]?.severity).toBe("error");
      expect(result.findings[0]?.nodeIds).toEqual([onboarding.node_id]);

      const densityProbe = probes.find((p) => p.chapterId === density.node_id);
      const onboardingProbe = probes.find((p) => p.chapterId === onboarding.node_id);
      expect(densityProbe?.retrievedSelf).toBe(true);
      expect(onboardingProbe?.retrievedSelf).toBe(false);

      // The verdict was "sufficient" (just for the wrong chapter), never
      // not-in-corpus, so nothing should have reached the miss log here.
      expect(await missLog.readAll()).toEqual([]);
    });
  });

  test("a not-in-corpus verdict is appended to the miss log", async () => {
    await withStore(async (store) => {
      const document = await buildOneChapterFixture(store);
      const density = document.volumes[0]?.chapters[0];
      if (!density) {
        throw new Error("unreachable");
      }

      // Deliberately gibberish, matching nothing in the fixture body/
      // frontmatter, so BM25 fallback (which resolveChosen tries whenever
      // navigate returns nothing) also comes up empty across all 3
      // bounded rounds (`round-loop.ts`'s MAX_ROUNDS) — the round loop
      // then exits with the default `not-in-corpus` verdict.
      const port = new FakeStructuredGenerationPort([
        { task: "zzqqxx nonexistent gibberish term" },
        { chosen: [], rejected: [] }, // round 1
        { chosen: [], rejected: [] }, // round 2
        { chosen: [], rejected: [] }, // round 3
      ]);
      const missLog = new InMemoryMissLog();

      const { result, probes } = await checkSelfRetrieval(document, store, port, { missLog });

      expect(probes[0]?.verdict).toEqual({ kind: "not-in-corpus" });
      expect(probes[0]?.retrievedSelf).toBe(false);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.code).toBe("self-retrieval-miss");

      const misses = await missLog.readAll();
      expect(misses).toHaveLength(1);
      expect(misses[0]?.task).toBe("zzqqxx nonexistent gibberish term");
      expect(misses[0]?.sourceChapterId).toBe(density.node_id);
    });
  });

  test("miss log append-only: two separate self-retrieval runs both land in the log", async () => {
    await withStore(async (store) => {
      const document = await buildOneChapterFixture(store);
      const missLog = new InMemoryMissLog();
      const missScript = [
        { task: "zzqqxx nonexistent gibberish term" },
        { chosen: [], rejected: [] },
        { chosen: [], rejected: [] },
        { chosen: [], rejected: [] },
      ];

      await checkSelfRetrieval(document, store, new FakeStructuredGenerationPort(missScript), {
        missLog,
      });
      await checkSelfRetrieval(document, store, new FakeStructuredGenerationPort(missScript), {
        missLog,
      });

      expect(await missLog.readAll()).toHaveLength(2);
    });
  });
});
