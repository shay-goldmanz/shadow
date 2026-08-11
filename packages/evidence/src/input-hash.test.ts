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
    // I-1 (Wave 2 review): `supports` carries each supporting claim's own
    // `inputHash`, not its bare label — see input-hash.ts's module doc.
    // These stand in for two such hashes.
    const base = { decontextualized: "Both treat spacing as a system constraint.", evidence: [] };
    const a = computeInputHash({ ...base, supports: [HASH_A] });
    const b = computeInputHash({ ...base, supports: [HASH_A, HASH_B] });
    expect(a).not.toBe(b);
  });

  // ---- I-1 (Wave 2 review): supports[] must hash each target's own inputHash, not its label ----

  test("supports[] hashing the same label twice with different underlying inputHashes does not collide (I-1)", () => {
    // Two hypothetical derived claims, both supported by a claim labeled
    // "lin-4px" — but in one case that supporting claim currently means
    // "4px" (hash A) and in the other it has since been re-cited to mean
    // "8px" (hash B). If `supports` carried the label instead of the target
    // claim's own inputHash, these would be indistinguishable — exactly the
    // silent-skip bug the review reproduced (claim B's text changed, claim
    // A's inputHash stayed put because it only ever saw the unchanged
    // label "lin-4px").
    const base = { decontextualized: "Both treat spacing as a system constraint.", evidence: [] };
    const a = computeInputHash({ ...base, supports: [HASH_A] });
    const b = computeInputHash({ ...base, supports: [HASH_B] });
    expect(a).not.toBe(b);
  });

  // ---- I-3: the Wave 1 review's verified collision ------------------------

  test("a boundary shift between decontextualized and evidence.exact does not collide (I-3, amendment 8)", () => {
    // Verified collision under the old plain-space join: these two inputs
    // differ only in where the word "uses" falls (decontextualized vs.
    // exact), and used to hash identically.
    const a = computeInputHash({
      decontextualized: "Linear uses",
      evidence: [{ exact: "grid", snapshotHash: HASH_A }],
      supports: [],
    });
    const b = computeInputHash({
      decontextualized: "Linear",
      evidence: [{ exact: "uses grid", snapshotHash: HASH_A }],
      supports: [],
    });
    expect(a).not.toBe(b);
  });

  test("a boundary shift between two evidence entries' exact text does not collide (I-3)", () => {
    // A single-evidence claim whose exact text is the concatenation of what
    // a two-evidence claim's entries would be — same characters overall,
    // different structure. A separator-based join without escaping could
    // still collide these depending on the separator choice; JSON encoding
    // cannot, since array/field boundaries are explicit in the output.
    const a = computeInputHash({
      decontextualized: "x",
      evidence: [{ exact: "first factsecond fact", snapshotHash: HASH_A }],
      supports: [],
    });
    const b = computeInputHash({
      decontextualized: "x",
      evidence: [
        { exact: "first fact", snapshotHash: HASH_A },
        { exact: "second fact", snapshotHash: HASH_A },
      ],
      supports: [],
    });
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
