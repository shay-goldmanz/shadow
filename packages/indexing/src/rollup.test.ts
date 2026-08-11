import { describe, expect, test } from "bun:test";
import { rollupScore } from "./rollup.ts";

describe("rollupScore — 1/√(N+1)·Σ", () => {
  test("N = 0 (no children) rolls up to exactly 0, not NaN", () => {
    expect(rollupScore([])).toBe(0);
  });

  test("a single child score of 4: 4 / √2", () => {
    expect(rollupScore([4])).toBeCloseTo(4 / Math.sqrt(2), 10);
  });

  test("hand-computed: [1, 2, 3] -> sum=6, N=3 -> 6 / √4 = 3", () => {
    expect(rollupScore([1, 2, 3])).toBeCloseTo(3, 10);
  });

  test("hand-computed: [5, 5, 5, 5] -> sum=20, N=4 -> 20 / √5", () => {
    expect(rollupScore([5, 5, 5, 5])).toBeCloseTo(20 / Math.sqrt(5), 10);
  });

  test("rewards many relevant units (same per-unit score) more than one, but less than linearly", () => {
    // A plain mean would score a node with one hit of magnitude X the same
    // as a node with ten hits each of magnitude X (both average to X).
    // This aggregator must tell them apart, rewarding the ten-hit node —
    // but sub-linearly, not 10x, which is the "diminishing returns" D11
    // and D11a describe.
    const oneHit = rollupScore([5]);
    const tenHits = rollupScore(Array(10).fill(5));
    expect(tenHits).toBeGreaterThan(oneHit);
    expect(tenHits).toBeLessThan(10 * oneHit);
  });

  test("a single zero-score child still divides by √2, not √1", () => {
    expect(rollupScore([0])).toBe(0);
    // Distinguishable from N=0 by an accompanying non-zero sibling.
    expect(rollupScore([0, 6])).toBeCloseTo(6 / Math.sqrt(3), 10);
  });
});
