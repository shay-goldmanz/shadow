import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemVolumeStore, toChapterSlug, toVolumeSlug, type VolumeStore } from "@shadow/core";
import { FakeStructuredGenerationPort } from "@shadow/model";
import { LintConfigError } from "./errors.ts";
import { StructuralIndexer } from "./indexer.ts";
import { runLint } from "./lint.ts";
import { chapter, document, volume } from "./lint-fixtures.ts";
import { InMemoryMissLog } from "./lint-miss-log.ts";
import { expectRejection } from "./test-helpers.ts";
import type { IndexDocument } from "./types.ts";

async function withStore(fn: (store: VolumeStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shadow-lint-test-"));
  try {
    await fn(new FileSystemVolumeStore(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function buildFixture(store: VolumeStore): Promise<IndexDocument> {
  const volumeSlug = toVolumeSlug("ui-design");
  await store.createVolume({ slug: volumeSlug, title: "Interface Design" });

  await store.putChapter(volumeSlug, {
    slug: toChapterSlug("linear-density"),
    title: "How Linear handles information density",
    body: "Linear renders table rows at a tight 32px height and truncates labels aggressively.\n",
    frontmatter: {
      when_to_use: "Designing dense tables, lists, and dashboards.",
      not_for: "onboarding flows",
      keywords: ["density", "linear", "row height"],
    },
  });

  await store.putChapter(volumeSlug, {
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
  const { document: builtDocument } = await indexer.build(store);
  return builtDocument;
}

describe("runLint --offline", () => {
  test("performs zero model calls — the fake is never invoked", async () => {
    const a = chapter({ node_id: "A", title: "A", when_to_use: "designing dense tables" });
    const b = chapter({ node_id: "B", title: "B", when_to_use: "writing onboarding copy" });
    const doc = document([volume({ volume_id: "v", chapters: [a, b] })]);
    const port = new FakeStructuredGenerationPort([]);

    const report = await runLint(doc, { port }, { offline: true });

    expect(port.calls).toHaveLength(0);
    expect(report.offline).toBe(true);
  });

  test("runs with no deps at all — store and port are not required", async () => {
    const a = chapter({ node_id: "A", title: "A", when_to_use: "designing dense tables" });
    const doc = document([volume({ volume_id: "v", chapters: [a] })]);

    const report = await runLint(doc, {}, { offline: true });

    expect(report.checks.map((c) => c.checkId).toSorted()).toEqual([
      "cost-model",
      "discriminability",
      "orphan",
    ]);
  });

  test("runs exactly checks 1, 3, and 6 — never 2 (self-retrieval) or 4 (contradiction)", async () => {
    const a = chapter({ node_id: "A", title: "A", when_to_use: "designing dense tables" });
    const doc = document([volume({ volume_id: "v", chapters: [a] })]);

    const report = await runLint(doc, {}, { offline: true });

    const checkIds = report.checks.map((c) => c.checkId);
    expect(checkIds).toContain("discriminability");
    expect(checkIds).toContain("cost-model");
    expect(checkIds).toContain("orphan");
    expect(checkIds).not.toContain("self-retrieval");
    expect(checkIds).not.toContain("contradiction");
    expect(report.checks.every((c) => !c.requiresModel)).toBe(true);
  });

  test("orphan detection offline reports every chapter as unprobed (no probes ran)", async () => {
    const a = chapter({ node_id: "A", title: "A", when_to_use: "designing dense tables" });
    const doc = document([volume({ volume_id: "v", chapters: [a] })]);

    const report = await runLint(doc, {}, { offline: true });

    const orphan = report.checks.find((c) => c.checkId === "orphan");
    expect(orphan?.findings).toHaveLength(1);
    expect(orphan?.findings[0]?.data).toEqual({ probed: false });
  });
});

describe("runLint online", () => {
  test("requires deps.store and deps.port; throws a typed error rather than silently skipping", async () => {
    const a = chapter({ node_id: "A", title: "A" });
    const doc = document([volume({ volume_id: "v", chapters: [a] })]);

    await expectRejection(runLint(doc, {}), LintConfigError);
  });

  test("runs all five checks, feeding self-retrieval's coverage into orphan detection", async () => {
    await withStore(async (store) => {
      const doc = await buildFixture(store);
      const density = doc.volumes[0]?.chapters.find((c) => c.slug === "linear-density");
      const onboarding = doc.volumes[0]?.chapters.find((c) => c.slug === "onboarding");
      if (!density || !onboarding) {
        throw new Error("unreachable");
      }

      const port = new FakeStructuredGenerationPort([
        { task: "how do I keep a dense table readable" },
        { chosen: [density.node_id], rejected: [] },
        { verdict: "sufficient" },
        { task: "how do I design a warm onboarding flow" },
        { chosen: [onboarding.node_id], rejected: [] },
        { verdict: "sufficient" },
      ]);
      const missLog = new InMemoryMissLog();

      const report = await runLint(doc, { store, port, missLog }, {});

      expect(report.offline).toBe(false);
      const checkIds = report.checks.map((c) => c.checkId).toSorted();
      expect(checkIds).toEqual(
        ["contradiction", "cost-model", "discriminability", "orphan", "self-retrieval"].toSorted(),
      );
      expect(report.probes).toHaveLength(2);

      // Both chapters retrieved themselves during self-retrieval, so
      // orphan detection (fed that coverage) finds nothing.
      const orphan = report.checks.find((c) => c.checkId === "orphan");
      expect(orphan?.findings).toHaveLength(0);
    });
  });
});
