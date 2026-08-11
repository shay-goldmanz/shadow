import { describe, expect, test } from "bun:test";
import { GoldenSetValidationError } from "../errors.ts";
import { loadGoldenSet, validateGoldenSet } from "./golden-set.ts";
import { GOLDEN_QUERIES } from "./golden-set-data.ts";
import type { GoldenSet } from "./types.ts";

const CORPUS = ["vol/a", "vol/b", "vol/c"];

function baseQuery(overrides: Partial<GoldenSet["queries"][number]> = {}) {
  return {
    id: "q1",
    query: "how do I do the thing",
    relevant: ["vol/a"],
    tags: ["single-chapter"] as const,
    ...overrides,
  };
}

describe("validateGoldenSet", () => {
  test("a well-formed golden set validates with no problems", () => {
    const goldenSet: GoldenSet = {
      version: "test",
      queries: [
        baseQuery(),
        baseQuery({ id: "q2", relevant: [], expectNotInCorpus: true, tags: ["not-in-corpus"] }),
      ],
    };
    expect(validateGoldenSet(goldenSet, CORPUS)).toEqual([]);
  });

  test("flags a relevant chapter that doesn't exist in the corpus", () => {
    const goldenSet: GoldenSet = {
      version: "t",
      queries: [baseQuery({ relevant: ["vol/ghost"] })],
    };
    const problems = validateGoldenSet(goldenSet, CORPUS);
    expect(problems.some((p) => p.includes("vol/ghost"))).toBe(true);
  });

  test("flags a judgedIrrelevant chapter that doesn't exist in the corpus", () => {
    const goldenSet: GoldenSet = {
      version: "t",
      queries: [baseQuery({ judgedIrrelevant: ["vol/ghost"] })],
    };
    const problems = validateGoldenSet(goldenSet, CORPUS);
    expect(problems.some((p) => p.includes("vol/ghost"))).toBe(true);
  });

  test("flags a duplicate query id", () => {
    const goldenSet: GoldenSet = { version: "t", queries: [baseQuery(), baseQuery()] };
    const problems = validateGoldenSet(goldenSet, CORPUS);
    expect(problems.some((p) => p.includes("duplicate"))).toBe(true);
  });

  test("flags empty relevant with expectNotInCorpus not set", () => {
    const goldenSet: GoldenSet = { version: "t", queries: [baseQuery({ relevant: [] })] };
    const problems = validateGoldenSet(goldenSet, CORPUS);
    expect(problems.some((p) => p.includes("expectNotInCorpus"))).toBe(true);
  });

  test("flags relevant chapters combined with expectNotInCorpus: true", () => {
    const goldenSet: GoldenSet = {
      version: "t",
      queries: [baseQuery({ relevant: ["vol/a"], expectNotInCorpus: true })],
    };
    const problems = validateGoldenSet(goldenSet, CORPUS);
    expect(problems.some((p) => p.includes("cannot have relevant"))).toBe(true);
  });

  test("flags a chapter judged both relevant and irrelevant at once", () => {
    const goldenSet: GoldenSet = {
      version: "t",
      queries: [baseQuery({ relevant: ["vol/a"], judgedIrrelevant: ["vol/a"] })],
    };
    const problems = validateGoldenSet(goldenSet, CORPUS);
    expect(problems.some((p) => p.includes("both relevant and judgedIrrelevant"))).toBe(true);
  });

  test("flags a query with no tags", () => {
    const goldenSet: GoldenSet = { version: "t", queries: [baseQuery({ tags: [] })] };
    const problems = validateGoldenSet(goldenSet, CORPUS);
    expect(problems.some((p) => p.includes("tag"))).toBe(true);
  });

  test("flags an empty query set", () => {
    const goldenSet: GoldenSet = { version: "t", queries: [] };
    const problems = validateGoldenSet(goldenSet, CORPUS);
    expect(problems.some((p) => p.includes("no queries"))).toBe(true);
  });

  test("reports every problem found, not just the first", () => {
    const goldenSet: GoldenSet = {
      version: "t",
      queries: [baseQuery({ relevant: ["vol/ghost"], tags: [] })],
    };
    const problems = validateGoldenSet(goldenSet, CORPUS);
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });
});

describe("loadGoldenSet", () => {
  test("the real committed golden set validates against its own listed chapter ids", () => {
    // Every relevant/judgedIrrelevant chapter this golden set names is
    // included in its own "corpus" here, so this only checks internal
    // consistency of the id strings themselves, not the real fixture
    // corpus (that cross-check lives in fixture-corpus.test.ts).
    const allIds = new Set<string>();
    for (const q of GOLDEN_QUERIES) {
      for (const id of q.relevant) allIds.add(id);
      for (const id of q.judgedIrrelevant ?? []) allIds.add(id);
    }
    expect(() => loadGoldenSet([...allIds])).not.toThrow();
  });

  test("throws GoldenSetValidationError against a corpus missing the queries' chapters", () => {
    expect(() => loadGoldenSet([])).toThrow(GoldenSetValidationError);
  });
});
