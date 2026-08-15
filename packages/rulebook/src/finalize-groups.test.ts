import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemRulebookStore, type VolumeSlug, toVolumeSlug } from "@shadow/core";
import {
  FakeStructuredGenerationPort,
  type FakeStructuredGenerationResponder,
  type StructuredGenerationPort,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
  type TokenUsage,
  ZERO_USAGE,
} from "@shadow/model";
import { finalizeGroups, FINALIZE_BATCH_SIZE } from "./finalize-groups.ts";
import type { ConsolidatedRule } from "./merge.ts";
import type { TaxonomyGroup } from "./schemas.ts";

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "shadow-rulebook-finalize-test-"));
}

async function makeRulebookStore(
  slugName: string,
): Promise<{ root: string; rulebookStore: FileSystemRulebookStore; slug: VolumeSlug }> {
  const root = await makeTempRoot();
  const rulebookStore = new FileSystemRulebookStore(root);
  const slug = toVolumeSlug(slugName);
  await rulebookStore.createRulebook({ slug, title: "Finalize Test" });
  return { root, rulebookStore, slug };
}

function rule(overrides: Partial<ConsolidatedRule>): ConsolidatedRule {
  return {
    label: "r-00000000",
    statement: "Borrowers must repay principal monthly.",
    normalizedQuotes: ["pay principal monthly"],
    proposedGroup: "payments",
    ...overrides,
  };
}

function group(overrides: Partial<TaxonomyGroup>): TaxonomyGroup {
  return {
    slug: "payments",
    title: "Payments",
    when_to_use: "Rules about repayment schedules.",
    not_for: "Collateral and default remedies.",
    keywords: ["payment"],
    ...overrides,
  };
}

/** Every rule's label, in order, padded so they sort/parse predictably. */
function manyRules(count: number, group_: string = "payments"): ConsolidatedRule[] {
  return Array.from({ length: count }, (_, i) =>
    rule({ label: `r-${String(i).padStart(5, "0")}`, proposedGroup: group_ }),
  );
}

/** A responder that assigns every label it sees in this batch's prompt to `groupSlug` — batch-content-driven, not positional, so it works regardless of how many batches the rules get split into. */
function respondAssigningAllTo(groupSlug: string): FakeStructuredGenerationResponder {
  return (request) => {
    const prompt = (request as StructuredGenerationRequest<unknown> & { prompt: string }).prompt;
    const labels = [...prompt.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1] as string);
    return { assignments: labels.map((label) => ({ label, group: groupSlug })) };
  };
}

/** Counts concurrently in-flight calls; records the high-water mark. */
class HighWaterMarkPort implements StructuredGenerationPort {
  inFlight = 0;
  maxInFlight = 0;
  calls = 0;

  constructor(private readonly responder: FakeStructuredGenerationResponder) {}

  async generate<Output>(
    request: StructuredGenerationRequest<Output>,
  ): Promise<StructuredGenerationResult<Output>> {
    this.calls += 1;
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
    const raw = await this.responder(request);
    this.inFlight -= 1;
    return { object: request.schema.parse(raw), usage: ZERO_USAGE };
  }
}

/** Reports real (non-zero) usage per call, unlike `FakeStructuredGenerationPort`. */
class UsageReportingPort implements StructuredGenerationPort {
  calls = 0;

  constructor(
    private readonly responder: FakeStructuredGenerationResponder,
    private readonly usage: TokenUsage,
  ) {}

  async generate<Output>(
    request: StructuredGenerationRequest<Output>,
  ): Promise<StructuredGenerationResult<Output>> {
    this.calls += 1;
    const raw = await this.responder(request);
    return { object: request.schema.parse(raw), usage: this.usage };
  }
}

describe("finalizeGroups", () => {
  test("short-circuits with no LLM call when there are no rules", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("no-rules");
    try {
      const structuredGeneration = new FakeStructuredGenerationPort([]);
      const result = await finalizeGroups(
        { structuredGeneration, rulebookStore },
        { rulebookSlug: slug, rules: [], groups: [group({})] },
      );

      expect(structuredGeneration.calls).toHaveLength(0);
      expect(result.assignments.size).toBe(0);
      expect(result.groups).toEqual([]);
      expect(result.totalBatches).toBe(0);
      expect(result.cachedBatches).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("assigns rules to the group the LLM names, dropping empty groups from the final list", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("basic-assign");
    try {
      const rules = [rule({ label: "r-a" }), rule({ label: "r-b", proposedGroup: "collateral" })];
      const groups = [group({ slug: "payments" }), group({ slug: "collateral" }), group({ slug: "general" })];

      const structuredGeneration = new FakeStructuredGenerationPort([
        { assignments: [{ label: "r-a", group: "payments" }, { label: "r-b", group: "payments" }] },
      ]);

      const result = await finalizeGroups(
        { structuredGeneration, rulebookStore },
        { rulebookSlug: slug, rules, groups },
      );

      expect(result.assignments.get("r-a")).toBe("payments");
      expect(result.assignments.get("r-b")).toBe("payments");
      // "collateral" and "general" got zero rules assigned — dropped.
      expect(result.groups.map((g) => g.slug)).toEqual(["payments"]);
      expect(result.totalBatches).toBe(1);
      expect(result.cachedBatches).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("falls back to a rule's own chunk-proposed group when the response omits its label", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("omission-fallback");
    try {
      const rules = [rule({ label: "r-a", proposedGroup: "collateral" })];
      const groups = [group({ slug: "payments" }), group({ slug: "collateral" })];

      const structuredGeneration = new FakeStructuredGenerationPort([{ assignments: [] }]);

      const result = await finalizeGroups(
        { structuredGeneration, rulebookStore },
        { rulebookSlug: slug, rules, groups },
      );

      expect(result.assignments.get("r-a")).toBe("collateral");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("routes an unknown group name in the response to general", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("unknown-group");
    try {
      const rules = [rule({ label: "r-a" })];
      const groups = [group({ slug: "payments" }), group({ slug: "general", title: "General" })];

      const structuredGeneration = new FakeStructuredGenerationPort([
        { assignments: [{ label: "r-a", group: "not-a-real-group" }] },
      ]);

      const result = await finalizeGroups(
        { structuredGeneration, rulebookStore },
        { rulebookSlug: slug, rules, groups },
      );

      expect(result.assignments.get("r-a")).toBe("general");
      expect(result.groups.map((g) => g.slug)).toEqual(["general"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("splits a group exceeding maxRulesPerGroup into -2, -3, ... in rule order, inheriting parent metadata", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("split-basic");
    try {
      const rules = Array.from({ length: 5 }, (_, i) => rule({ label: `r-${i}` }));
      const groups = [group({ slug: "payments", title: "Payments" })];

      const structuredGeneration = new FakeStructuredGenerationPort([
        { assignments: rules.map((r) => ({ label: r.label, group: "payments" })) },
      ]);

      const result = await finalizeGroups(
        { structuredGeneration, rulebookStore },
        { rulebookSlug: slug, rules, groups, maxRulesPerGroup: 2 },
      );

      expect(result.groups.map((g) => g.slug)).toEqual(["payments", "payments-2", "payments-3"]);
      expect(result.groups.map((g) => g.title)).toEqual(["Payments", "Payments (2)", "Payments (3)"]);
      // Every split still carries the parent's routing metadata.
      expect(result.groups.every((g) => g.when_to_use === groups[0]?.when_to_use)).toBe(true);

      expect(result.assignments.get("r-0")).toBe("payments");
      expect(result.assignments.get("r-1")).toBe("payments");
      expect(result.assignments.get("r-2")).toBe("payments-2");
      expect(result.assignments.get("r-3")).toBe("payments-2");
      expect(result.assignments.get("r-4")).toBe("payments-3");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not split a group exactly at maxRulesPerGroup", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("split-exact");
    try {
      const rules = Array.from({ length: 2 }, (_, i) => rule({ label: `r-${i}` }));
      const groups = [group({ slug: "payments" })];

      const structuredGeneration = new FakeStructuredGenerationPort([
        { assignments: rules.map((r) => ({ label: r.label, group: "payments" })) },
      ]);

      const result = await finalizeGroups(
        { structuredGeneration, rulebookStore },
        { rulebookSlug: slug, rules, groups, maxRulesPerGroup: 2 },
      );

      expect(result.groups.map((g) => g.slug)).toEqual(["payments"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("batch-boundary neutrality: same content batched into many small batches or one single batch produces byte-identical assignments and groups", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("batch-neutrality");
    const reference = await makeRulebookStore("batch-neutrality-reference");
    try {
      const rules = manyRules(37);
      const groups = [group({ slug: "payments" })];

      const batchedResult = await finalizeGroups(
        { structuredGeneration: new FakeStructuredGenerationPort(respondAssigningAllTo("payments")), rulebookStore },
        { rulebookSlug: slug, rules, groups, maxRulesPerGroup: 40, batchSize: 5 },
      );

      const singleBatchResult = await finalizeGroups(
        {
          structuredGeneration: new FakeStructuredGenerationPort(respondAssigningAllTo("payments")),
          rulebookStore: reference.rulebookStore,
        },
        { rulebookSlug: reference.slug, rules, groups, maxRulesPerGroup: 40, batchSize: 1000 },
      );

      expect(batchedResult.totalBatches).toBe(8); // ceil(37 / 5)
      expect(singleBatchResult.totalBatches).toBe(1);
      const byLabel = (a: readonly [string, string], b: readonly [string, string]) => a[0].localeCompare(b[0]);
      expect([...batchedResult.assignments.entries()].sort(byLabel)).toEqual(
        [...singleBatchResult.assignments.entries()].sort(byLabel),
      );
      expect(batchedResult.groups).toEqual(singleBatchResult.groups);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(reference.root, { recursive: true, force: true });
    }
  });

  test("global split correctness across batch boundaries: a group whose rules straddle two different batches still splits once, correctly, not once per batch", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("split-across-batches");
    try {
      // 90 rules, all assigned "payments" — with batchSize 60, this straddles
      // two batches (60 + 30). maxRulesPerGroup 40 must still split the
      // GLOBAL bucket of 90 into 40/40/10 (three groups), never split
      // per-batch (which would wrongly yield 40/20 from batch one and 30
      // from batch two — four groups, with a broken rule count in the last
      // one of the first batch's split).
      const rules = manyRules(90);
      const groups = [group({ slug: "payments", title: "Payments" })];

      const result = await finalizeGroups(
        { structuredGeneration: new FakeStructuredGenerationPort(respondAssigningAllTo("payments")), rulebookStore },
        { rulebookSlug: slug, rules, groups, maxRulesPerGroup: 40, batchSize: 60 },
      );

      expect(result.totalBatches).toBe(2);
      expect(result.groups.map((g) => g.slug)).toEqual(["payments", "payments-2", "payments-3"]);

      const countsBySlug = new Map<string, number>();
      for (const slugAssigned of result.assignments.values()) {
        countsBySlug.set(slugAssigned, (countsBySlug.get(slugAssigned) ?? 0) + 1);
      }
      expect(countsBySlug.get("payments")).toBe(40);
      expect(countsBySlug.get("payments-2")).toBe(40);
      expect(countsBySlug.get("payments-3")).toBe(10);

      // The split boundary follows overall rule order (r-00000 .. r-00089),
      // not batch order — r-00039 (index 39, the 40th rule) is the last rule
      // in the first split even though it falls in the first 60-rule batch,
      // and r-00040 (index 40, still within the first batch) is already in
      // the second split.
      expect(result.assignments.get("r-00039")).toBe("payments");
      expect(result.assignments.get("r-00040")).toBe("payments-2");
      expect(result.assignments.get("r-00079")).toBe("payments-2");
      expect(result.assignments.get("r-00080")).toBe("payments-3");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("omission fallback still applies per-rule across multiple batches", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("omission-across-batches");
    try {
      // Every rule proposes "collateral" at the chunk level; the LLM never
      // assigns anything (simulating a batch whose response omitted every
      // label) — every rule across every batch must still fall back to its
      // own proposed group.
      const rules = manyRules(12, "collateral");
      const groups = [group({ slug: "payments" }), group({ slug: "collateral" })];

      const result = await finalizeGroups(
        { structuredGeneration: new FakeStructuredGenerationPort(() => ({ assignments: [] })), rulebookStore },
        { rulebookSlug: slug, rules, groups, batchSize: 4 },
      );

      expect(result.totalBatches).toBe(3);
      for (const r of rules) {
        expect(result.assignments.get(r.label)).toBe("collateral");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a cache hit for a batch skips the port and reports zero usage; a miss calls the port and writes the cache", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("cache-hit-miss");
    try {
      const rules = manyRules(3);
      const groups = [group({})];
      const args = { rulebookSlug: slug, rules, groups };

      const first = await finalizeGroups(
        { structuredGeneration: new FakeStructuredGenerationPort(respondAssigningAllTo("payments")), rulebookStore },
        args,
      );
      expect(first.cachedBatches).toBe(0);
      expect(first.totalBatches).toBe(1);

      const secondPort = new FakeStructuredGenerationPort([]); // no fixtures queued — a call would throw
      const second = await finalizeGroups({ structuredGeneration: secondPort, rulebookStore }, args);

      expect(second.cachedBatches).toBe(1);
      expect(secondPort.calls).toHaveLength(0);
      expect(second.assignments).toEqual(first.assignments);
      expect(second.usage).toEqual(ZERO_USAGE);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a changed group menu invalidates the cache even for the same rules", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("menu-change-invalidates");
    try {
      const rules = manyRules(3);
      const groups = [group({ slug: "payments" })];

      await finalizeGroups(
        { structuredGeneration: new FakeStructuredGenerationPort(respondAssigningAllTo("payments")), rulebookStore },
        { rulebookSlug: slug, rules, groups },
      );

      const differentGroups = [group({ slug: "payments" }), group({ slug: "general", title: "General" })];
      const secondPort = new FakeStructuredGenerationPort(respondAssigningAllTo("payments"));
      const second = await finalizeGroups(
        { structuredGeneration: secondPort, rulebookStore },
        { rulebookSlug: slug, rules, groups: differentGroups },
      );

      expect(second.cachedBatches).toBe(0);
      expect(secondPort.calls).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("malformed cached JSON is treated as a cache miss, not a crash", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("malformed-cache");
    try {
      const rules = manyRules(2);
      const groups = [group({})];

      // Prime the cache with garbage under whatever key this exact input
      // would hash to — easiest way to do that deterministically is to run
      // once for real, then corrupt what was written.
      const structuredGeneration = new FakeStructuredGenerationPort(respondAssigningAllTo("payments"));
      await finalizeGroups({ structuredGeneration, rulebookStore }, { rulebookSlug: slug, rules, groups });

      // Corrupt every cache file under this rulebook's cache dir.
      const cacheDir = join(root, "rulebooks", slug, "cache", "extraction");
      const glob = new Bun.Glob("*.json");
      for await (const file of glob.scan({ cwd: cacheDir })) {
        await Bun.write(join(cacheDir, file), JSON.stringify({ not: "the expected shape" }));
      }

      const secondPort = new FakeStructuredGenerationPort(respondAssigningAllTo("payments"));
      const result = await finalizeGroups(
        { structuredGeneration: secondPort, rulebookStore },
        { rulebookSlug: slug, rules, groups },
      );

      expect(result.cachedBatches).toBe(0);
      expect(secondPort.calls).toHaveLength(1);
      expect(result.assignments.get(rules[0]?.label as string)).toBe("payments");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("usage accumulates across batches and is zero for cache hits", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("usage-accumulation");
    try {
      const rules = manyRules(9);
      const groups = [group({})];
      const usage: TokenUsage = { inputTokens: 40, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 };

      const first = await finalizeGroups(
        {
          structuredGeneration: new UsageReportingPort(respondAssigningAllTo("payments"), usage),
          rulebookStore,
        },
        { rulebookSlug: slug, rules, groups, batchSize: 3 },
      );

      expect(first.totalBatches).toBe(3);
      expect(first.usage).toEqual({
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });

      const second = await finalizeGroups(
        {
          structuredGeneration: new UsageReportingPort(respondAssigningAllTo("payments"), usage),
          rulebookStore,
        },
        { rulebookSlug: slug, rules, groups, batchSize: 3 },
      );
      expect(second.cachedBatches).toBe(3);
      expect(second.usage).toEqual(ZERO_USAGE);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("respects the concurrency bound across batch calls", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("concurrency-bound");
    try {
      const rules = manyRules(24);
      const groups = [group({})];

      const port = new HighWaterMarkPort(respondAssigningAllTo("payments"));
      const result = await finalizeGroups(
        { structuredGeneration: port, rulebookStore },
        { rulebookSlug: slug, rules, groups, batchSize: 2, concurrency: 3 },
      );

      expect(result.totalBatches).toBe(12);
      expect(port.calls).toBe(12);
      expect(port.maxInFlight).toBeLessThanOrEqual(3);
      expect(port.maxInFlight).toBeGreaterThan(1); // actually ran concurrently, not serially
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("FINALIZE_BATCH_SIZE default splits a large rule set into multiple batches", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("default-batch-size");
    try {
      const total = FINALIZE_BATCH_SIZE + 5;
      const rules = manyRules(total);
      const groups = [group({})];

      const result = await finalizeGroups(
        { structuredGeneration: new FakeStructuredGenerationPort(respondAssigningAllTo("payments")), rulebookStore },
        { rulebookSlug: slug, rules, groups, maxRulesPerGroup: total },
      );

      expect(result.totalBatches).toBe(2);
      expect(result.assignments.size).toBe(total);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("forwards args.model to the port; omitting it forwards undefined", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("model-forward");
    try {
      const rules = manyRules(2);
      const groups = [group({})];

      const withModel = new FakeStructuredGenerationPort(respondAssigningAllTo("payments"));
      await finalizeGroups(
        { structuredGeneration: withModel, rulebookStore },
        { rulebookSlug: slug, rules, groups, model: "opus" },
      );
      expect(withModel.calls[0]?.model).toBe("opus");

      const withoutModel = new FakeStructuredGenerationPort(respondAssigningAllTo("payments"));
      await finalizeGroups(
        { structuredGeneration: withoutModel, rulebookStore },
        { rulebookSlug: slug, rules: manyRules(2, "collateral"), groups: [group({ slug: "collateral" })] },
      );
      expect(withoutModel.calls[0]?.model).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("determinism: rules arriving in different orders still produce identical batch hashes and group membership", async () => {
    // `args.rules`' arrival order tracks chunk-extraction COMPLETION order
    // upstream (nondeterministic even on a fully-cached re-run), so this
    // module must sort by label before batching/bucketing rather than trust
    // that order. Two runs over the same rule set, shuffled differently,
    // must hit the identical per-batch cache key and land every rule in the
    // identical (possibly split) group.
    const forward = await makeRulebookStore("determinism-forward");
    const shuffled = await makeRulebookStore("determinism-shuffled");
    try {
      const rules = manyRules(90);
      const reversedRules = [...rules].reverse();
      const groups = [group({ slug: "payments", title: "Payments" })];

      const forwardPort = new FakeStructuredGenerationPort(respondAssigningAllTo("payments"));
      const forwardResult = await finalizeGroups(
        { structuredGeneration: forwardPort, rulebookStore: forward.rulebookStore },
        { rulebookSlug: forward.slug, rules, groups, maxRulesPerGroup: 40, batchSize: 60 },
      );

      // Same rules, arrival order reversed, batch size shifted so batch
      // boundaries land differently too — the sort must make both
      // irrelevant.
      const shuffledPort = new FakeStructuredGenerationPort(respondAssigningAllTo("payments"));
      const shuffledResult = await finalizeGroups(
        { structuredGeneration: shuffledPort, rulebookStore: shuffled.rulebookStore },
        { rulebookSlug: shuffled.slug, rules: reversedRules, groups, maxRulesPerGroup: 40, batchSize: 37 },
      );

      const byLabel = (a: readonly [string, string], b: readonly [string, string]) => a[0].localeCompare(b[0]);
      expect([...shuffledResult.assignments.entries()].sort(byLabel)).toEqual(
        [...forwardResult.assignments.entries()].sort(byLabel),
      );
      expect(shuffledResult.groups).toEqual(forwardResult.groups);

      // The batch cache key is stable across arrival order too: priming the
      // cache from the forward run, then re-running the shuffled order
      // against the SAME store, must hit the cache for every batch despite
      // different batch boundaries and reversed input order.
      const primed = await makeRulebookStore("determinism-primed");
      try {
        await finalizeGroups(
          { structuredGeneration: new FakeStructuredGenerationPort(respondAssigningAllTo("payments")), rulebookStore: primed.rulebookStore },
          { rulebookSlug: primed.slug, rules, groups, maxRulesPerGroup: 40, batchSize: 60 },
        );

        const rerunPort = new FakeStructuredGenerationPort([]); // no fixtures queued — a call would throw
        const rerun = await finalizeGroups(
          { structuredGeneration: rerunPort, rulebookStore: primed.rulebookStore },
          { rulebookSlug: primed.slug, rules: reversedRules, groups, maxRulesPerGroup: 40, batchSize: 60 },
        );

        expect(rerun.cachedBatches).toBe(rerun.totalBatches);
        expect(rerunPort.calls).toHaveLength(0);
      } finally {
        await rm(primed.root, { recursive: true, force: true });
      }
    } finally {
      await rm(forward.root, { recursive: true, force: true });
      await rm(shuffled.root, { recursive: true, force: true });
    }
  });

  test("a changed model invalidates a batch's cache even for the same menu and rules", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("model-change-invalidates");
    try {
      const rules = manyRules(3);
      const groups = [group({ slug: "payments" })];
      const args = { rulebookSlug: slug, rules, groups };

      const first = await finalizeGroups(
        { structuredGeneration: new FakeStructuredGenerationPort(respondAssigningAllTo("payments")), rulebookStore },
        args,
      );
      expect(first.cachedBatches).toBe(0);

      // Same menu, same rules, still-unset model -> re-running hits the cache...
      const stillDefault = await finalizeGroups(
        { structuredGeneration: new FakeStructuredGenerationPort([]), rulebookStore },
        args,
      );
      expect(stillDefault.cachedBatches).toBe(1);

      // ...but an explicit model must miss the cache built under "default".
      const withModelPort = new FakeStructuredGenerationPort(respondAssigningAllTo("payments"));
      const withModel = await finalizeGroups(
        { structuredGeneration: withModelPort, rulebookStore },
        { ...args, model: "opus" },
      );
      expect(withModel.cachedBatches).toBe(0);
      expect(withModelPort.calls).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
