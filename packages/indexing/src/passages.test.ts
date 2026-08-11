import { describe, expect, test } from "bun:test";
import { toBytes } from "./byte-text.ts";
import { assemblePassages, type PassageSource } from "./passages.ts";

const body = "AAAA BBBB CCCC DDDD"; // 4-char words at 0,5,10,15, each span 4 bytes wide
const bytes = toBytes(body);

function source(id: string, start: number, len = 4): PassageSource {
  return { node_id: id, heading_path: [id], span: { start_byte: start, end_byte: start + len } };
}

describe("assemblePassages — document order, not relevance order", () => {
  test("returns passages sorted by span position, even when given in reverse-relevance order", () => {
    // "Most relevant first" ranking: D (pos 15), A (pos 0), C (pos 10).
    const ranked = [source("D", 15), source("A", 0), source("C", 10)];
    const passages = assemblePassages(bytes, ranked);
    expect(passages.map((p) => p.node_id)).toEqual(["A", "C", "D"]);
  });

  test("slices the correct text for each passage", () => {
    const passages = assemblePassages(bytes, [source("B", 5)]);
    expect(passages[0]?.text).toBe("BBBB");
  });

  test("preserves heading_path and span on each passage", () => {
    const src: PassageSource = {
      node_id: "X",
      heading_path: ["Chapter", "Section"],
      span: { start_byte: 0, end_byte: 4 },
    };
    const [passage] = assemblePassages(bytes, [src]);
    expect(passage?.heading_path).toEqual(["Chapter", "Section"]);
    expect(passage?.span).toEqual({ start_byte: 0, end_byte: 4 });
  });

  test("an empty source list produces an empty passage list", () => {
    expect(assemblePassages(bytes, [])).toEqual([]);
  });

  test("does not mutate the input array's order", () => {
    const ranked = [source("D", 15), source("A", 0)];
    const originalOrder = ranked.map((s) => s.node_id);
    assemblePassages(bytes, ranked);
    expect(ranked.map((s) => s.node_id)).toEqual(originalOrder);
  });

  test("ties in span position keep their relative input order (stable sort)", () => {
    const same = [source("first", 0), source("second", 0)];
    const passages = assemblePassages(bytes, same);
    expect(passages.map((p) => p.node_id)).toEqual(["first", "second"]);
  });
});
