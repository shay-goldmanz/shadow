import { describe, expect, test } from "bun:test";
import { FakeStructuredGenerationPort } from "@shadow/model";
import { expectRejection, withTinyCorpus } from "../test-helpers.ts";
import {
  AblationNavigationAgent,
  buildAblationBodyExcerpts,
  createAblationStrategy,
} from "./ablation-strategy.ts";

describe("AblationNavigationAgent — structural isolation of routing metadata", () => {
  test("the navigate prompt carries the body excerpt but never the chapter's when_to_use/not_for text", async () => {
    await withTinyCorpus(async ({ store, document }) => {
      const density = document.volumes[0]?.chapters.find((c) => c.slug === "density");
      if (!density) throw new Error("unreachable");
      // Sanity: the fixture really does carry distinctive when_to_use/not_for text
      // that would leak into the prompt if the ablation agent read those fields.
      expect(density.when_to_use).toContain("Designing dense tables");
      expect(density.not_for).toContain("onboarding");

      const fake = new FakeStructuredGenerationPort((request) => {
        if (request.schemaName === "ablation_navigate_decision") {
          expect(request.prompt).toContain("Linear renders table rows"); // body excerpt present
          expect(request.prompt).not.toContain("Designing dense tables"); // when_to_use absent
          expect(request.prompt).not.toContain(density.not_for ?? "__unset__"); // not_for absent
          return { chosen: [density.node_id], rejected: [] };
        }
        return { verdict: "sufficient" };
      });

      // createAblationStrategy builds its own AblationNavigationAgent
      // internally (with its own body-excerpt fetch) — the assertions above
      // run inside the shared fake port's responder regardless, so this
      // exercises the real construction path rather than a hand-built agent.
      const strategy = await createAblationStrategy(store, document, fake, {});

      const result = await strategy.retrieve("Linear table density");
      expect(result.retrieved).toEqual(["ui/density"]);
    });
  });

  test("route() throws rather than silently using routing metadata if ever called", async () => {
    await withTinyCorpus(async ({ store, document }) => {
      const excerpts = await buildAblationBodyExcerpts(store, document);
      const fake = new FakeStructuredGenerationPort([]);
      const agent = new AblationNavigationAgent(fake, excerpts);
      await expectRejection(agent.route({ stage: "route", skip: false, volumes: [] }), Error);
    });
  });
});

describe("createAblationStrategy — end to end over a fake port", () => {
  test("resolves citations to ChapterId and reports found/not-in-corpus verdicts", async () => {
    await withTinyCorpus(async ({ store, document }) => {
      const onboarding = document.volumes[0]?.chapters.find((c) => c.slug === "onboarding");
      if (!onboarding) throw new Error("unreachable");

      const fake = new FakeStructuredGenerationPort((request) => {
        if (request.schemaName === "ablation_navigate_decision") {
          return { chosen: [onboarding.node_id], rejected: [] };
        }
        return { verdict: "sufficient" };
      });
      const strategy = await createAblationStrategy(store, document, fake);
      const result = await strategy.retrieve("welcome new users to the product");
      expect(result.retrieved).toEqual(["ui/onboarding"]);
      expect(result.verdict).toBe("found");
    });
  });

  test("a navigate response choosing nothing, every round, yields not-in-corpus", async () => {
    await withTinyCorpus(async ({ store, document }) => {
      const fake = new FakeStructuredGenerationPort(() => ({ chosen: [], rejected: [] }));
      const strategy = await createAblationStrategy(store, document, fake);
      const result = await strategy.retrieve("zzqx wobblefrog blorptastic");
      expect(result.retrieved).toEqual([]);
      expect(result.verdict).toBe("not-in-corpus");
    });
  });
});
