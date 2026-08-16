import { describe, expect, test } from "bun:test";
import { FakeStructuredGenerationPort, type StructuredGenerationRequest } from "@shadow/model";
import { IndexMissingError } from "../errors.ts";
import { createMissLog, widenMisses } from "../miss-log.ts";
import { buildSmallFixture, withStore } from "../test-fixture.ts";
import { runFind } from "./find.ts";
import { runLintCommand } from "./lint.ts";
import { runMisses } from "./misses.ts";

describe("runLintCommand --offline", () => {
  test("runs the zero-model checks and reports next_steps, without touching the miss log", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store, root);
      const result = await runLintCommand(store, root, { offline: true });

      expect(result.offline).toBe(true);
      expect(result.checks.map((c) => c.checkId).toSorted()).toEqual([
        "cost-model",
        "discriminability",
        "orphan",
      ]);
      expect(result.next_steps.length).toBeGreaterThan(0);
      expect(await runMisses(root)).toMatchObject({ count: 0 });
    });
  });

  test("before `shadow index` has ever run, throws IndexMissingError like every other read-side command", async () => {
    await withStore(async (store, root) => {
      const error = await runLintCommand(store, root, { offline: true }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IndexMissingError);
    });
  });
});

/**
 * Deterministically drives every self-retrieval probe to a `not-in-corpus`
 * verdict: `navigate_decision` always returns nothing chosen, so the round
 * loop exhausts without ever calling `grade_verdict`. No network, no real
 * model — `FakeStructuredGenerationPort` is `@shadow/model`'s own sanctioned
 * offline test double (used throughout `@shadow/indexing`'s own suite).
 */
function alwaysMissPort(): FakeStructuredGenerationPort {
  return new FakeStructuredGenerationPort((request: StructuredGenerationRequest<unknown>) => {
    switch (request.schemaName) {
      case "plausible_task":
        return { task: "a task nothing in this corpus answers" };
      case "route_decision":
        return { chosenVolumeIds: [], why: "n/a" };
      case "navigate_decision":
        return { chosen: [], rejected: [] };
      case "grade_verdict":
        return { verdict: "not-in-corpus" };
      case "contradiction_judgment":
        // Sibling chapters in the small fixture may or may not clear the
        // pre-filter threshold; answer "no conflict" either way so this
        // test stays about the miss log, not contradiction findings.
        return { conflicting: false, reason: "not exercised by this test" };
      default:
        throw new Error(`unexpected schemaName: ${request.schemaName}`);
    }
  });
}

describe("runLintCommand online — self-retrieval shares shadow find's miss log (T2.7)", () => {
  test("a self-retrieval not-in-corpus verdict is appended to the same misses.jsonl shadow find writes to", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store, root);
      const port = alwaysMissPort();

      const report = await runLintCommand(store, root, { offline: false }, { port });

      expect(report.offline).toBe(false);
      const selfRetrieval = report.checks.find((c) => c.checkId === "self-retrieval");
      expect(selfRetrieval?.findings.length).toBeGreaterThan(0);

      const misses = widenMisses(await createMissLog(root).readAll());
      // One entry per chapter in the small fixture, all lint-shaped (no `reason`/`source`).
      expect(misses.length).toBeGreaterThan(0);
      for (const miss of misses) {
        expect(miss.reason).toBeUndefined();
        expect(miss.sourceChapterId).toBeDefined();
      }
    });
  });

  test("interleaves with shadow find's writes in one file, append-only, both formats intact", async () => {
    await withStore(async (store, root) => {
      await buildSmallFixture(store, root);

      // Writer 1: shadow find, a real not-in-corpus verdict.
      await runFind(store, root, "sourdough bread baking technique", { none: true });

      // Writer 2: shadow lint's self-retrieval, via the real production
      // command with a deterministic fake port.
      await runLintCommand(store, root, { offline: false }, { port: alwaysMissPort() });

      // Writer 1 again — proves append-only survives a second run and
      // does not clobber what writer 2 just added.
      await runFind(store, root, "another totally unrelated query", { none: true });

      const misses = widenMisses(await createMissLog(root).readAll());
      const findMisses = misses.filter((m) => m.source === "find");
      const lintMisses = misses.filter((m) => m.source !== "find");

      expect(findMisses).toHaveLength(2);
      expect(findMisses[0]?.task).toBe("sourdough bread baking technique");
      expect(findMisses[1]?.task).toBe("another totally unrelated query");
      expect(lintMisses.length).toBeGreaterThan(0);

      // Ordering: writer 1's first entry, then writer 2's batch, then
      // writer 1's second entry — exactly the call order above.
      expect(misses[0]?.task).toBe("sourdough bread baking technique");
      expect(misses.at(-1)?.task).toBe("another totally unrelated query");

      // `shadow misses` renders every entry from both writers, unified.
      const rendered = await runMisses(root);
      expect(rendered.count).toBe(misses.length);
    });
  });
});
