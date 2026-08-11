import { describe, expect, test } from "bun:test";
import type { Sha256Digest } from "./digest.ts";
import { computeInputHash } from "./input-hash.ts";

const HASH_A =
  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Sha256Digest;
const HASH_B =
  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Sha256Digest;

describe("computeInputHash", () => {
  test("is deterministic for identical inputs", () => {
    const input = {
      decontextualized: "Linear renders its sidebar on a 4px spacing scale.",
      evidence: [{ exact: "Every measurement is a multiple of four.", snapshotHash: HASH_A }],
      supports: [],
    };
    expect(computeInputHash(input)).toBe(computeInputHash({ ...input }));
  });

  test("stable when prose changes but claim and evidence do not", () => {
    const evidence = [{ exact: "Every measurement is a multiple of four.", snapshotHash: HASH_A }];
    const a = computeInputHash({
      decontextualized: "Linear renders its sidebar on a 4px spacing scale.",
      evidence,
      supports: [],
    });
    // Same decontextualized meaning + same evidence, only the surface
    // sentence text differs — inputHash is computed independent of
    // Claim.text entirely, so this call doesn't even take it as input.
    const b = computeInputHash({
      decontextualized: "Linear renders its sidebar on a 4px spacing scale.",
      evidence,
      supports: [],
    });
    expect(a).toBe(b);
  });

  test("changes when the decontextualized meaning changes", () => {
    const evidence = [{ exact: "Every measurement is a multiple of four.", snapshotHash: HASH_A }];
    const a = computeInputHash({
      decontextualized: "Linear renders its sidebar on a 4px spacing scale.",
      evidence,
      supports: [],
    });
    const b = computeInputHash({
      decontextualized: "Linear renders its sidebar on an 8px spacing scale.",
      evidence,
      supports: [],
    });
    expect(a).not.toBe(b);
  });

  test("changes when the cited exact text changes", () => {
    const base = {
      decontextualized: "Linear renders its sidebar on a 4px spacing scale.",
      supports: [],
    };
    const a = computeInputHash({
      ...base,
      evidence: [{ exact: "Every measurement is a multiple of four.", snapshotHash: HASH_A }],
    });
    const b = computeInputHash({
      ...base,
      evidence: [{ exact: "Every measurement is a multiple of eight.", snapshotHash: HASH_A }],
    });
    expect(a).not.toBe(b);
  });

  test("changes when a cited snapshot drifts (same exact text, new hash)", () => {
    const base = {
      decontextualized: "Linear renders its sidebar on a 4px spacing scale.",
      supports: [],
    };
    const a = computeInputHash({
      ...base,
      evidence: [{ exact: "Every measurement is a multiple of four.", snapshotHash: HASH_A }],
    });
    const b = computeInputHash({
      ...base,
      evidence: [{ exact: "Every measurement is a multiple of four.", snapshotHash: HASH_B }],
    });
    expect(a).not.toBe(b);
  });

  test("changes when supports[] changes for a derived claim", () => {
    const base = { decontextualized: "Both treat spacing as a system constraint.", evidence: [] };
    const a = computeInputHash({ ...base, supports: ["lin-4px"] });
    const b = computeInputHash({ ...base, supports: ["lin-4px", "notion-ws"] });
    expect(a).not.toBe(b);
  });

  test("evidence order matters", () => {
    const base = { decontextualized: "Two corroborating citations.", supports: [] };
    const a = computeInputHash({
      ...base,
      evidence: [
        { exact: "first fact", snapshotHash: HASH_A },
        { exact: "second fact", snapshotHash: HASH_B },
      ],
    });
    const b = computeInputHash({
      ...base,
      evidence: [
        { exact: "second fact", snapshotHash: HASH_B },
        { exact: "first fact", snapshotHash: HASH_A },
      ],
    });
    expect(a).not.toBe(b);
  });
});
