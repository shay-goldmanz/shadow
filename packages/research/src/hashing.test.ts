import { describe, expect, test } from "bun:test";
import { formatHash, hashOf, sha256Hex } from "./hashing.ts";

// This package's own `sha256Hex`/`formatHash`/`hashOf` are a general-purpose
// hashing utility used internally for fixture-corpus content-addressing
// (`fixture-corpus.ts` — URL/query/payload cache keys), independent of
// `docs/EVIDENCE.md`'s snapshot-digest schema. The D16 two-digest property
// (`payloadSha256` vs `normalizedTextSha256`) is tested end to end in
// `content.test.ts`, against `@shadow/evidence`'s `computeSnapshotDigests`
// — see that file's `describe("D16 ...")` block and `docs/EVIDENCE.md`
// amendment 4 for why the digest computation itself lives there, not here.

describe("sha256Hex / formatHash", () => {
  test("hashes a string and formats it with the sha256: prefix", () => {
    const hex = sha256Hex("hello world");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(formatHash(hex)).toBe(`sha256:${hex}`);
    expect(hashOf("hello world")).toBe(`sha256:${hex}`);
  });

  test("hashes raw bytes the same way it hashes the equivalent UTF-8 string", () => {
    const text = "hello world";
    const bytes = new TextEncoder().encode(text);
    expect(sha256Hex(bytes)).toBe(sha256Hex(text));
  });

  test("is deterministic", () => {
    expect(sha256Hex("shadow")).toBe(sha256Hex("shadow"));
  });
});
