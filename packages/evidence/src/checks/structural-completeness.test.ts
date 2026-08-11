import { describe, expect, test } from "bun:test";
import { makeClaim, makeEvidenceSpan, makeSidecar } from "../test-helpers.ts";
import { checkStructuralCompleteness } from "./structural-completeness.ts";

describe("checkStructuralCompleteness (C1a)", () => {
  test("passes a well-formed chapter", () => {
    const body = "Linear uses a 4px grid.[^lin-4px] Notion prefers whitespace.[^notion-ws]";
    const sidecar = makeSidecar({
      claims: [
        makeClaim({ label: "lin-4px", kind: "sourced", evidence: [makeEvidenceSpan()] }),
        makeClaim({ label: "notion-ws", kind: "sourced", evidence: [makeEvidenceSpan()] }),
      ],
    });
    const result = checkStructuralCompleteness({ chapterBody: body, sidecar });
    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test("orphan marker: no claim record", () => {
    const body = "An unsourced-looking claim.[^ghost]";
    const sidecar = makeSidecar({ claims: [] });
    const result = checkStructuralCompleteness({ chapterBody: body, sidecar });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.code === "orphan-marker" && i.label === "ghost")).toBe(true);
  });

  test("orphan record: claim exists but chapter has no marker for it", () => {
    const body = "Plain prose with no citations at all.";
    const sidecar = makeSidecar({
      claims: [makeClaim({ label: "unused", kind: "sourced", evidence: [makeEvidenceSpan()] })],
    });
    const result = checkStructuralCompleteness({ chapterBody: body, sidecar });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.code === "orphan-record" && i.label === "unused")).toBe(
      true,
    );
  });

  test("duplicate label used by two markers", () => {
    const body = "First claim.[^dup] Second, different claim.[^dup]";
    const sidecar = makeSidecar({
      claims: [makeClaim({ label: "dup", kind: "sourced", evidence: [makeEvidenceSpan()] })],
    });
    const result = checkStructuralCompleteness({ chapterBody: body, sidecar });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.code === "duplicate-label" && i.label === "dup")).toBe(true);
  });

  test("reused-after-delete label is rejected even though it looks orphan-clean", () => {
    const body = "A brand-new claim reusing an old label.[^lin-4px]";
    const sidecar = makeSidecar({
      claims: [makeClaim({ label: "lin-4px", kind: "sourced", evidence: [makeEvidenceSpan()] })],
    });
    const result = checkStructuralCompleteness({
      chapterBody: body,
      sidecar,
      retiredLabels: new Set(["lin-4px"]),
    });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.code === "reused-label" && i.label === "lin-4px")).toBe(
      true,
    );
  });

  test("derived claim pointing at a missing supports[] target", () => {
    const body = "A derived conclusion.[^=conclusion]";
    const sidecar = makeSidecar({
      claims: [makeClaim({ label: "conclusion", kind: "derived", supports: ["nonexistent"] })],
    });
    const result = checkStructuralCompleteness({ chapterBody: body, sidecar });
    expect(result.passed).toBe(false);
    expect(
      result.issues.some((i) => i.code === "supports-target-missing" && i.label === "conclusion"),
    ).toBe(true);
  });

  test("derived claim with empty supports[] fails", () => {
    const body = "A derived conclusion.[^=conclusion]";
    const sidecar = makeSidecar({
      claims: [makeClaim({ label: "conclusion", kind: "derived", supports: [] })],
    });
    const result = checkStructuralCompleteness({ chapterBody: body, sidecar });
    expect(result.issues.some((i) => i.code === "missing-supports")).toBe(true);
  });

  test("sourced claim with no evidence fails", () => {
    const body = "A sourced claim with nothing behind it.[^bare]";
    const sidecar = makeSidecar({
      claims: [makeClaim({ label: "bare", kind: "sourced", evidence: [] })],
    });
    const result = checkStructuralCompleteness({ chapterBody: body, sidecar });
    expect(result.issues.some((i) => i.code === "missing-evidence" && i.label === "bare")).toBe(
      true,
    );
  });

  test("a supports[] cycle is detected (two-claim cycle)", () => {
    const body = "First.[^=a] Second.[^=b]";
    const sidecar = makeSidecar({
      claims: [
        makeClaim({ label: "a", kind: "derived", supports: ["b"] }),
        makeClaim({ label: "b", kind: "derived", supports: ["a"] }),
      ],
    });
    const result = checkStructuralCompleteness({ chapterBody: body, sidecar });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.code === "supports-cycle")).toBe(true);
  });

  test("a supports[] self-cycle is detected", () => {
    const body = "Self-referential.[^=a]";
    const sidecar = makeSidecar({
      claims: [makeClaim({ label: "a", kind: "derived", supports: ["a"] })],
    });
    const result = checkStructuralCompleteness({ chapterBody: body, sidecar });
    expect(result.issues.some((i) => i.code === "supports-cycle")).toBe(true);
  });

  test("a longer acyclic supports[] chain passes", () => {
    const body = "A.[^a] B.[^=b] C.[^=c]";
    const sidecar = makeSidecar({
      claims: [
        makeClaim({ label: "a", kind: "sourced", evidence: [makeEvidenceSpan()] }),
        makeClaim({ label: "b", kind: "derived", supports: ["a"] }),
        makeClaim({ label: "c", kind: "derived", supports: ["b"] }),
      ],
    });
    const result = checkStructuralCompleteness({ chapterBody: body, sidecar });
    expect(result.passed).toBe(true);
  });

  test("marker kind prefix mismatch with declared claim kind is flagged", () => {
    const body = "Claims to be derived but isn't.[^=mixed]";
    const sidecar = makeSidecar({
      claims: [makeClaim({ label: "mixed", kind: "sourced", evidence: [makeEvidenceSpan()] })],
    });
    const result = checkStructuralCompleteness({ chapterBody: body, sidecar });
    expect(result.issues.some((i) => i.code === "kind-mismatch" && i.label === "mixed")).toBe(true);
  });
});
