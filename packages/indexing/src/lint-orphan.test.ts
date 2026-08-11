import { describe, expect, test } from "bun:test";
import { chapter, document, section, volume } from "./lint-fixtures.ts";
import { checkOrphans } from "./lint-orphan.ts";

describe("checkOrphans", () => {
  test("a multi-chapter fixture: chapters never covered are flagged, covered ones are not", () => {
    const covered = chapter({ node_id: "A", title: "Covered" });
    const orphaned = chapter({ node_id: "B", title: "Orphan" });
    const alsoOrphaned = chapter({ node_id: "C", title: "Also orphan" });
    const doc = document([volume({ volume_id: "v", chapters: [covered, orphaned, alsoOrphaned] })]);

    const result = checkOrphans(doc, new Set(["A"]));

    expect(result.checkId).toBe("orphan");
    expect(result.requiresModel).toBe(false);
    const orphanIds = result.findings
      .map((f) => f.nodeIds[0])
      .toSorted((a, b) => (a ?? "").localeCompare(b ?? ""));
    expect(orphanIds).toEqual(["B", "C"]);
    for (const finding of result.findings) {
      expect(finding.code).toBe("orphan-chapter");
      expect(finding.severity).toBe("warning");
      expect(finding.data).toEqual({ probed: true });
    }
  });

  test("a chapter is covered if any of its sections were cited, not just the chapter node_id itself", () => {
    const s = section({ node_id: "A#intro", title: "Intro" });
    const c = chapter({ node_id: "A", title: "Chapter", sections: [s] });
    const doc = document([volume({ volume_id: "v", chapters: [c] })]);

    const result = checkOrphans(doc, new Set(["A#intro"]));

    expect(result.findings).toHaveLength(0);
  });

  test("a chapter is covered if a nested subsection was cited", () => {
    const nested = section({ node_id: "A#a/b", title: "Nested" });
    const top = section({ node_id: "A#a", title: "Top", sections: [nested] });
    const c = chapter({ node_id: "A", title: "Chapter", sections: [top] });
    const doc = document([volume({ volume_id: "v", chapters: [c] })]);

    const result = checkOrphans(doc, new Set(["A#a/b"]));

    expect(result.findings).toHaveLength(0);
  });

  test("an empty coverage set reports every chapter as orphaned, tagged as unprobed", () => {
    const a = chapter({ node_id: "A", title: "A" });
    const b = chapter({ node_id: "B", title: "B" });
    const doc = document([volume({ volume_id: "v", chapters: [a, b] })]);

    const result = checkOrphans(doc, new Set());

    expect(result.findings).toHaveLength(2);
    for (const finding of result.findings) {
      expect(finding.data).toEqual({ probed: false });
      expect(finding.message).toContain("has not been probed");
    }
  });

  test("multi-volume fixture: orphans are detected independently per volume", () => {
    const a = chapter({ node_id: "A", title: "A" });
    const b = chapter({ node_id: "B", title: "B" });
    const doc = document([
      volume({ volume_id: "v1", chapters: [a] }),
      volume({ volume_id: "v2", chapters: [b] }),
    ]);

    const result = checkOrphans(doc, new Set(["A"]));

    expect(result.findings.map((f) => f.nodeIds[0])).toEqual(["B"]);
  });
});
