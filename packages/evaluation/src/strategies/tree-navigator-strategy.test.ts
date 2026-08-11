import { describe, expect, test } from "bun:test";
import type {
  GradePayload,
  NavigateDecision,
  NavigatePayload,
  NavigationAgent,
  RetrievalVerdict,
  RouteDecision,
  RoutePayload,
} from "@shadow/indexing";
import { ModelNavigationAgent } from "@shadow/indexing";
import { FakeStructuredGenerationPort } from "@shadow/model";
import { withTinyCorpus } from "../test-helpers.ts";
import { MeasuringStructuredGenerationPort, ZERO_TOKEN_COST } from "./token-tracking.ts";
import { TreeNavigatorStrategy } from "./tree-navigator-strategy.ts";

/** A scripted `NavigationAgent` driven entirely by test code — no model, deterministic, matching `@shadow/indexing`'s own test pattern (`navigator.test.ts`). */
class ScriptedAgent implements NavigationAgent {
  constructor(
    private readonly navigateScript: (payload: NavigatePayload) => NavigateDecision,
    private readonly gradeScript: (payload: GradePayload) => RetrievalVerdict,
  ) {}

  async route(_payload: RoutePayload): Promise<RouteDecision> {
    throw new Error("route() should not be called under the routing threshold");
  }

  async navigate(payload: NavigatePayload): Promise<NavigateDecision> {
    return this.navigateScript(payload);
  }

  async grade(payload: GradePayload): Promise<RetrievalVerdict> {
    return this.gradeScript(payload);
  }
}

describe("TreeNavigatorStrategy — scripted agent, no model", () => {
  test("resolves citations down to ChapterId and reports rounds", async () => {
    await withTinyCorpus(async ({ store, document }) => {
      const density = document.volumes[0]?.chapters.find((c) => c.slug === "density");
      if (!density) throw new Error("unreachable");

      const agent = new ScriptedAgent(
        () => ({ chosen: [density.node_id], rejected: [] }),
        () => ({ kind: "sufficient" }),
      );
      const strategy = new TreeNavigatorStrategy(store, document, agent);
      const result = await strategy.retrieve("Linear table density");

      expect(result.retrieved).toEqual(["ui/density"]);
      expect(result.verdict).toBe("found");
      expect(result.rounds).toBe(1);
    });
  });

  test("not-in-corpus verdict yields an empty retrieval and matching verdict", async () => {
    await withTinyCorpus(async ({ store, document }) => {
      const agent = new ScriptedAgent(
        () => ({ chosen: [], rejected: [] }),
        () => ({ kind: "sufficient" }), // never reached: nothing chosen
      );
      const strategy = new TreeNavigatorStrategy(store, document, agent);
      const result = await strategy.retrieve("zzqx wobblefrog blorptastic snorgle");

      expect(result.retrieved).toEqual([]);
      expect(result.verdict).toBe("not-in-corpus");
    });
  });

  test("with no costTracker supplied, tokenCost is ZERO_TOKEN_COST — a scripted agent spends nothing", async () => {
    await withTinyCorpus(async ({ store, document }) => {
      const agent = new ScriptedAgent(
        () => ({ chosen: [], rejected: [] }),
        () => ({ kind: "sufficient" }),
      );
      const strategy = new TreeNavigatorStrategy(store, document, agent);
      const result = await strategy.retrieve("anything");
      expect(result.tokenCost).toEqual(ZERO_TOKEN_COST);
    });
  });
});

describe("TreeNavigatorStrategy — ModelNavigationAgent over a fake port", () => {
  test("token cost is tracked end-to-end through MeasuringStructuredGenerationPort", async () => {
    await withTinyCorpus(async ({ store, document }) => {
      const density = document.volumes[0]?.chapters.find((c) => c.slug === "density");
      if (!density) throw new Error("unreachable");

      const fake = new FakeStructuredGenerationPort((request) => {
        if (request.schemaName === "navigate_decision") {
          return { chosen: [density.node_id], rejected: [] };
        }
        return { verdict: "sufficient" };
      });
      const measuring = new MeasuringStructuredGenerationPort(fake);
      const agent = new ModelNavigationAgent(measuring);
      const strategy = new TreeNavigatorStrategy(store, document, agent, {
        costTracker: measuring,
      });

      const result = await strategy.retrieve("Linear table density");
      expect(result.retrieved).toEqual(["ui/density"]);
      // Two structured-generation calls this round: navigate + grade.
      expect(result.tokenCost.llmCalls).toBe(2);
      expect(result.tokenCost.estimatedPromptTokens).toBeGreaterThan(0);
      // FakeStructuredGenerationPort always returns ZERO_USAGE — real usage
      // is a live-mode-only signal, deliberately zero here.
      expect(result.tokenCost.usage.inputTokens).toBe(0);
    });
  });

  test("cost resets between queries rather than accumulating across retrieve() calls", async () => {
    await withTinyCorpus(async ({ store, document }) => {
      const fake = new FakeStructuredGenerationPort(() => ({ chosen: [], rejected: [] }));
      const measuring = new MeasuringStructuredGenerationPort(fake);
      const agent = new ModelNavigationAgent(measuring);
      const strategy = new TreeNavigatorStrategy(store, document, agent, {
        costTracker: measuring,
      });

      const first = await strategy.retrieve("zzqx wobblefrog");
      const second = await strategy.retrieve("blorptastic snorgle");
      // Each not-in-corpus query only ever calls navigate() (no chosen ->
      // no grade), 3 rounds each (round loop exhausts) since nothing is
      // ever chosen — cost per call should be identical, not cumulative.
      expect(second.tokenCost.llmCalls).toBe(first.tokenCost.llmCalls);
    });
  });
});
