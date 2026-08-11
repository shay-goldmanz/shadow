import { describe, expect, test } from "bun:test";
import { generateUlid, isValidUlid } from "./ulid.ts";

describe("generateUlid", () => {
  test("produces a 26-character Crockford Base32 string", () => {
    const id = generateUlid();
    expect(id).toHaveLength(26);
    expect(isValidUlid(id)).toBe(true);
  });

  test("two calls produce different ids", () => {
    expect(generateUlid()).not.toBe(generateUlid());
  });

  test("the timestamp prefix reflects the injected `now`", () => {
    const a = generateUlid(0);
    const b = generateUlid(0);
    // Same millisecond -> identical 10-char timestamp component.
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    // Different from a much later timestamp.
    const later = generateUlid(Date.UTC(2030, 0, 1));
    expect(later.slice(0, 10)).not.toBe(a.slice(0, 10));
  });

  test("never uses the excluded Crockford characters I, L, O, U", () => {
    const id = generateUlid();
    expect(id).not.toMatch(/[ILOU]/);
  });
});

describe("isValidUlid", () => {
  test("rejects the wrong length", () => {
    expect(isValidUlid("TOOSHORT")).toBe(false);
  });

  test("rejects non-string input", () => {
    expect(isValidUlid(12345)).toBe(false);
    expect(isValidUlid(undefined)).toBe(false);
    expect(isValidUlid(null)).toBe(false);
  });

  test("rejects excluded characters even at the right length", () => {
    const rightLengthWrongAlphabet = `${"0".repeat(25)}O`; // 26 chars, but 'O' is excluded
    expect(rightLengthWrongAlphabet).toHaveLength(26);
    expect(isValidUlid(rightLengthWrongAlphabet)).toBe(false);
  });

  test("accepts a freshly generated id", () => {
    expect(isValidUlid(generateUlid())).toBe(true);
  });
});
