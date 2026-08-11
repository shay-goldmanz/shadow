import { describe, expect, test } from "bun:test";
import { InvalidIdError } from "./errors.ts";
import {
  isValidClaimId,
  isValidSourceId,
  newClaimId,
  newSourceId,
  toClaimId,
  toSourceId,
} from "./ids.ts";

describe("source ids", () => {
  test("newSourceId mints a valid, src_-prefixed id", () => {
    const id = newSourceId();
    expect(id.startsWith("src_")).toBe(true);
    expect(isValidSourceId(id)).toBe(true);
    expect(toSourceId(id)).toBe(id);
  });

  test("rejects a claim id passed as a source id", () => {
    const claimId = newClaimId();
    expect(() => toSourceId(claimId)).toThrow(InvalidIdError);
    expect(isValidSourceId(claimId)).toBe(false);
  });

  test("rejects a malformed id", () => {
    expect(() => toSourceId("src_not-a-ulid")).toThrow(InvalidIdError);
  });
});

describe("claim ids", () => {
  test("newClaimId mints a valid, clm_-prefixed id", () => {
    const id = newClaimId();
    expect(id.startsWith("clm_")).toBe(true);
    expect(isValidClaimId(id)).toBe(true);
    expect(toClaimId(id)).toBe(id);
  });

  test("ids minted at different times are distinct", () => {
    expect(newClaimId(1_700_000_000_000)).not.toBe(newClaimId(1_700_000_000_001));
  });
});
