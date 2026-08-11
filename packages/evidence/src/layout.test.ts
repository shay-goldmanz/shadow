import { describe, expect, test } from "bun:test";
import { type ChapterSlug, InvalidSlugError, toChapterSlug } from "@shadow/core";
import type { Sha256Digest } from "./digest.ts";
import { InvalidDigestError, InvalidIdError } from "./errors.ts";
import type { SourceId } from "./ids.ts";
import { EvidenceLayout } from "./layout.ts";

/**
 * C-3 (Wave 1 review): `EvidenceLayout` re-validates every identifier it
 * joins onto a path, so a forged branded value (an unsafe cast, or a bare
 * string deserialized from JSON — exactly what an LLM-authored sidecar
 * would produce in Wave 2) cannot escape the evidence directory.
 *
 * Verified escapes *before* this fix: `claimsPath("../../../../tmp/pwn" as
 * ChapterSlug)` -> `/tmp/pwn.claims.json`; `snapshotPath("sha256:../../../../tmp/pwn")`
 * -> `/tmp/pwn.txt`. Both must now throw instead of resolving.
 */
describe("EvidenceLayout: path construction re-validates its inputs (security boundary, C-3)", () => {
  const layout = new EvidenceLayout("/safe/evidence/root");

  test("claimsPath rejects a forged traversal chapter slug rather than joining it", () => {
    const forged = "../../../../tmp/pwn" as unknown as ChapterSlug;
    expect(() => layout.claimsPath(forged)).toThrow(InvalidSlugError);
  });

  test("auditPath rejects a forged traversal chapter slug", () => {
    const forged = "../../../../tmp/pwn" as unknown as ChapterSlug;
    expect(() => layout.auditPath(forged)).toThrow(InvalidSlugError);
  });

  test("claimsPath rejects an absolute-path chapter slug", () => {
    const forged = "/etc/passwd" as unknown as ChapterSlug;
    expect(() => layout.claimsPath(forged)).toThrow(InvalidSlugError);
  });

  test("claimsPath rejects a null-byte chapter slug", () => {
    const forged = "abc\0def" as unknown as ChapterSlug;
    expect(() => layout.claimsPath(forged)).toThrow(InvalidSlugError);
  });

  test("sourcePath rejects a forged traversal source id", () => {
    const forged = "../../../../tmp/pwn" as unknown as SourceId;
    expect(() => layout.sourcePath(forged)).toThrow(InvalidIdError);
  });

  test("sourcePath rejects a well-formed-looking but unprefixed id", () => {
    const forged = "01HQ8ZK4M2N7P9R3T5V8W1X6Y0" as unknown as SourceId;
    expect(() => layout.sourcePath(forged)).toThrow(InvalidIdError);
  });

  test("snapshotPath rejects a forged traversal digest", () => {
    const forged = "sha256:../../../../tmp/pwn" as unknown as Sha256Digest;
    expect(() => layout.snapshotPath(forged)).toThrow(InvalidDigestError);
  });

  test("snapshotPath rejects a digest with the wrong algorithm prefix", () => {
    const forged = `md5:${"a".repeat(64)}` as unknown as Sha256Digest;
    expect(() => layout.snapshotPath(forged)).toThrow(InvalidDigestError);
  });

  test("legitimately validated identifiers still resolve normally", () => {
    const chapter = toChapterSlug("how-linear-designs-ui");
    expect(layout.claimsPath(chapter)).toBe(
      "/safe/evidence/root/claims/how-linear-designs-ui.claims.json",
    );
    expect(layout.auditPath(chapter)).toBe(
      "/safe/evidence/root/audits/how-linear-designs-ui.audit.json",
    );
  });
});
