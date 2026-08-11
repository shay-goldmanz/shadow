import { describe, expect, test } from "bun:test";
import { parseFootnoteMarkers } from "./footnotes.ts";

describe("parseFootnoteMarkers", () => {
  test("extracts a sourced marker", () => {
    const body =
      "Linear renders its sidebar on a 4px spacing scale.[^lin-4px]\n\n[^lin-4px]: Linear.";
    const { markers, malformed } = parseFootnoteMarkers(body);
    expect(malformed).toEqual([]);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ label: "lin-4px", kind: "sourced" });
  });

  test("extracts a derived marker with = prefix", () => {
    const body = "Both treat spacing as a system constraint.[^=derived-systemic]";
    const { markers } = parseFootnoteMarkers(body);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ label: "derived-systemic", kind: "derived" });
  });

  test("extracts an operator marker with ~ prefix", () => {
    const body = "The operator prefers borders over shadows.[^~op-borders]";
    const { markers } = parseFootnoteMarkers(body);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ label: "op-borders", kind: "operator" });
  });

  test("does not match footnote definition lines", () => {
    const body = [
      "A claim.[^lin-4px]",
      "",
      "[^lin-4px]: Linear — How we built Linear's design system (src_01HQ8ZK)",
    ].join("\n");
    const { markers } = parseFootnoteMarkers(body);
    expect(markers).toHaveLength(1);
    expect(markers[0]?.label).toBe("lin-4px");
  });

  test("extracts multiple distinct markers in document order", () => {
    const body = "A.[^first] B.[^second] C.[^=third]";
    const { markers } = parseFootnoteMarkers(body);
    expect(markers.map((m) => m.label)).toEqual(["first", "second", "third"]);
    expect(markers.map((m) => m.kind)).toEqual(["sourced", "sourced", "derived"]);
  });

  test("reports a malformed (non-kebab-case) label", () => {
    const body = "A claim.[^Lin_4px]";
    const { markers, malformed } = parseFootnoteMarkers(body);
    expect(markers).toEqual([]);
    expect(malformed).toHaveLength(1);
    expect(malformed[0]?.raw).toBe("[^Lin_4px]");
  });

  test("no markers in plain prose", () => {
    const { markers, malformed } = parseFootnoteMarkers("Just a sentence with no citations.");
    expect(markers).toEqual([]);
    expect(malformed).toEqual([]);
  });
});
