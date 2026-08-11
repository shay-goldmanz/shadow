import { describe, expect, test } from "bun:test";
import { digestHex, isValidDigest, sha256Of, toDigest } from "./digest.ts";
import { InvalidDigestError } from "./errors.ts";

describe("sha256Of", () => {
  test("is deterministic and formatted as sha256:<hex>", () => {
    const digest = sha256Of("hello world");
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sha256Of("hello world")).toBe(digest);
  });

  test("different input produces a different digest", () => {
    expect(sha256Of("a")).not.toBe(sha256Of("b"));
  });

  test("accepts raw bytes", () => {
    const bytes = new TextEncoder().encode("hello world");
    expect(sha256Of(bytes)).toBe(sha256Of("hello world"));
  });
});

describe("digestHex", () => {
  test("strips the sha256: prefix", () => {
    const digest = sha256Of("content");
    expect(digestHex(digest)).toBe(digest.slice("sha256:".length));
    expect(digestHex(digest)).not.toContain(":");
  });
});

describe("toDigest / isValidDigest", () => {
  test("accepts a well-formed digest", () => {
    const raw = `sha256:${"a".repeat(64)}`;
    expect(toDigest(raw) as string).toBe(raw);
    expect(isValidDigest(raw)).toBe(true);
  });

  test("rejects a malformed digest", () => {
    expect(() => toDigest("not-a-digest")).toThrow(InvalidDigestError);
    expect(isValidDigest("sha256:tooshort")).toBe(false);
    expect(isValidDigest(`md5:${"a".repeat(64)}`)).toBe(false);
  });
});
