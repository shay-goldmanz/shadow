import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemVolumeStore, toChapterSlug, toVolumeSlug, type VolumeStore } from "@shadow/core";
import { StructuralIndexer } from "./indexer.ts";
import {
  type GradePayload,
  type NavigatePayload,
  type NavigationAgent,
  ReasoningNavigator,
  type RouteDecision,
  type RoutePayload,
} from "./navigator.ts";
import type { NavigateDecision } from "./round-loop.ts";
import type { RetrievalVerdict } from "./trace.ts";
import type { IndexDocument } from "./types.ts";

async function withStore(fn: (store: VolumeStore, root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "shadow-navigator-test-"));
  try {
    await fn(new FileSystemVolumeStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A scripted `NavigationAgent` driven entirely by test code — never a real model, keeping this test offline and deterministic. */
class ScriptedAgent implements NavigationAgent {
  public readonly navigateCalls: NavigatePayload[] = [];
  public readonly gradeCalls: GradePayload[] = [];

  constructor(
    private readonly navigateScript: (
      payload: NavigatePayload,
      callIndex: number,
    ) => NavigateDecision,
    private readonly gradeScript: (payload: GradePayload, callIndex: number) => RetrievalVerdict,
    private readonly routeScript?: (payload: RoutePayload) => RouteDecision,
  ) {}

  async route(payload: RoutePayload): Promise<RouteDecision> {
    if (!this.routeScript) {
      throw new Error("route() should not be called when the corpus is at or under the threshold");
    }
    return this.routeScript(payload);
  }

  async navigate(payload: NavigatePayload): Promise<NavigateDecision> {
    this.navigateCalls.push(payload);
    return this.navigateScript(payload, this.navigateCalls.length - 1);
  }

  async grade(payload: GradePayload): Promise<RetrievalVerdict> {
    this.gradeCalls.push(payload);
    return this.gradeScript(payload, this.gradeCalls.length - 1);
  }
}

async function buildFixture(store: VolumeStore, root: string): Promise<IndexDocument> {
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

  const indexer = new StructuralIndexer({ rootDir: root });
  const { document } = await indexer.build(store);
  return document;
}

describe("ReasoningNavigator.find — route stage skipped under threshold", () => {
  test("a corpus at or under 60 chapters never calls agent.route", async () => {
    await withStore(async (store, root) => {
      const document = await buildFixture(store, root);
      const density = document.volumes[0]?.chapters.find((c) => c.slug === "linear-density");
      if (!density) {
        throw new Error("unreachable");
      }

      const agent = new ScriptedAgent(
        () => ({ chosen: [density.node_id], rejected: [] }),
        () => ({ kind: "sufficient" }),
      );
      const navigator = new ReasoningNavigator(store, agent);

      // No throw means route() was never invoked (ScriptedAgent throws if it is).
      const trace = await navigator.find(document, "Linear row height density");
      expect(trace.verdict).toEqual({ kind: "sufficient" });
    });
  });
});

describe("ReasoningNavigator.find — a query resolved sufficiently in round 1", () => {
  test("cites the chosen chapter with a hash-pinned, real-body-slicing span", async () => {
    await withStore(async (store, root) => {
      const document = await buildFixture(store, root);
      const density = document.volumes[0]?.chapters.find((c) => c.slug === "linear-density");
      if (!density) {
        throw new Error("unreachable");
      }

      const agent = new ScriptedAgent(
        () => ({ chosen: [density.node_id], rejected: [] }),
        () => ({ kind: "sufficient" }),
      );
      const navigator = new ReasoningNavigator(store, agent);
      const trace = await navigator.find(document, "Linear row height density");

      expect(trace.rounds).toBe(1);
      expect(trace.verdict).toEqual({ kind: "sufficient" });
      expect(trace.citations).toHaveLength(1);
      expect(trace.citations[0]?.node_id).toBe(density.node_id);
      expect(trace.citations[0]?.content_hash).toBe(density.content_hash);
      expect(trace.citations[0]?.span).toEqual(density.span);

      // grade() received real passage text sliced from the actual chapter body.
      expect(agent.gradeCalls[0]?.passages[0]?.text).toContain("Linear renders table rows");

      // No disagreement: the agent's pick matches BM25's own top hit for this query.
      expect(trace.trace.some((step) => step.step === "disagreement")).toBe(false);
    });
  });
});

describe("ReasoningNavigator.find — BM25 fallback fires when navigation returns nothing", () => {
  test("promotes BM25's top hit and still reaches a verdict", async () => {
    await withStore(async (store, root) => {
      const document = await buildFixture(store, root);

      const agent = new ScriptedAgent(
        () => ({ chosen: [], rejected: [] }), // navigation finds nothing every round
        () => ({ kind: "sufficient" }),
      );
      const navigator = new ReasoningNavigator(store, agent);
      const trace = await navigator.find(document, "Linear row height 32px");

      const fallbackStep = trace.trace.find((step) => step.step === "bm25-fallback");
      expect(fallbackStep).toBeDefined();
      if (fallbackStep?.step === "bm25-fallback") {
        expect(fallbackStep.hits[0]?.score).toBeGreaterThan(0);
      }
      expect(trace.verdict).toEqual({ kind: "sufficient" });
      expect(trace.citations.length).toBeGreaterThan(0);
    });
  });

  test("BM25 fallback finding nothing at all yields not-in-corpus", async () => {
    await withStore(async (store, root) => {
      const document = await buildFixture(store, root);
      const agent = new ScriptedAgent(
        () => ({ chosen: [], rejected: [] }),
        () => ({ kind: "sufficient" }), // never reached: no citations to grade
      );
      const navigator = new ReasoningNavigator(store, agent);
      const trace = await navigator.find(document, "zzqx wobblefrog blorptastic snorgle");
      expect(trace.verdict.kind).toBe("not-in-corpus");
      expect(trace.citations).toEqual([]);
    });
  });
});

describe("ReasoningNavigator.find — disagreement signal", () => {
  test("fires when the agent's pick diverges from BM25's independent top hit", async () => {
    await withStore(async (store, root) => {
      const document = await buildFixture(store, root);
      const onboarding = document.volumes[0]?.chapters.find((c) => c.slug === "onboarding");
      if (!onboarding) {
        throw new Error("unreachable");
      }

      // Query is all about Linear/density vocabulary, but the agent picks
      // the unrelated onboarding chapter anyway.
      const agent = new ScriptedAgent(
        () => ({ chosen: [onboarding.node_id], rejected: [] }),
        () => ({ kind: "sufficient" }),
      );
      const navigator = new ReasoningNavigator(store, agent);
      const trace = await navigator.find(document, "Linear row height density tables");

      const disagreement = trace.trace.find((step) => step.step === "disagreement");
      expect(disagreement).toBeDefined();
      if (disagreement?.step === "disagreement") {
        expect(disagreement.signal.agentChosen).toEqual([onboarding.node_id]);
        expect(disagreement.signal.bm25TopNodeId).not.toBe(onboarding.node_id);
      }
    });
  });
});

describe("ReasoningNavigator.find — round loop: visited[], rejections, hard stop at 3", () => {
  test("visited[] excludes previously-shown chapters, rejections are recorded with reasons, and round 4 never runs", async () => {
    await withStore(async (store, root) => {
      const volume = toVolumeSlug("v");
      await store.createVolume({ slug: volume, title: "V" });
      for (let i = 0; i < 4; i += 1) {
        await store.putChapter(volume, {
          slug: toChapterSlug(`c${i}`),
          title: `Chapter ${i}`,
          body: `Body text for chapter ${i}.\n`,
        });
      }
      const indexer = new StructuralIndexer({ rootDir: root });
      const { document } = await indexer.build(store);
      const chapterIds = document.volumes[0]?.chapters.map((c) => c.node_id) ?? [];
      const [id0, id1] = chapterIds;
      if (!id0 || !id1) {
        throw new Error("unreachable");
      }

      const agent = new ScriptedAgent(
        (payload, callIndex) => {
          // Reject the chapter at this round's index (with a reason), never choose one —
          // forces need-more every round, all the way to the hard stop.
          const target = payload.chapters[0];
          return target
            ? {
                chosen: [],
                rejected: [{ node_id: target.node_id, why: `round ${callIndex + 1} reason` }],
              }
            : { chosen: [], rejected: [] };
        },
        () => ({ kind: "need-more", refinedQuery: "refined" }),
      );
      const navigator = new ReasoningNavigator(store, agent);
      const trace = await navigator.find(document, "some query");

      // Exactly 3 navigate calls (rounds 1-3), never a 4th.
      expect(agent.navigateCalls).toHaveLength(3);
      expect(trace.rounds).toBe(3);

      // Round 2's payload excludes what round 1 rejected; round 3's excludes rounds 1-2.
      expect(agent.navigateCalls[0]?.visited).toEqual([]);
      expect(agent.navigateCalls[1]?.visited).toEqual([id0]);
      expect(agent.navigateCalls[2]?.visited).toEqual([id0, id1]);
      // And the chapters actually offered never include an already-visited id.
      expect(agent.navigateCalls[1]?.chapters.map((c) => c.node_id)).not.toContain(id0);
      expect(agent.navigateCalls[2]?.chapters.map((c) => c.node_id)).not.toContain(id0);
      expect(agent.navigateCalls[2]?.chapters.map((c) => c.node_id)).not.toContain(id1);

      // Rejections recorded with reasons, in the trace's navigate steps.
      const navigateSteps = trace.trace.filter((step) => step.step === "navigate");
      expect(navigateSteps).toHaveLength(3);
      for (const [i, step] of navigateSteps.entries()) {
        const expectedId = chapterIds[i];
        if (step.step === "navigate" && expectedId) {
          expect(step.rejected).toEqual([{ node_id: expectedId, why: `round ${i + 1} reason` }]);
        }
      }
    });
  });
});
