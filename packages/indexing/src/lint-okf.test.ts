import { describe, expect, test } from "bun:test";
import { chapter, document, volume } from "./lint-fixtures.ts";
import {
  checkOkfConformance,
  type OkfBundleArtifacts,
  type OkfChapterRecord,
  type OkfVolumeRecord,
} from "./lint-okf.ts";

function oc(
  overrides: Partial<OkfChapterRecord> & { slug: string; node_id: string },
): OkfChapterRecord {
  return {
    title: overrides.slug,
    type: "Design Guidance",
    generated: { by: "shadow/1.0", at: "2026-01-01T00:00:00.000Z" },
    ...overrides,
  };
}

function ov(overrides: Partial<OkfVolumeRecord> & { volume_id: string }): OkfVolumeRecord {
  return {
    title: overrides.volume_id,
    type: "Volume",
    generated: { by: "shadow/1.0", at: "2026-01-01T00:00:00.000Z" },
    ...overrides,
  };
}

const artifacts: OkfBundleArtifacts = { rootIndexOkfVersion: true, logExists: true };

describe("checkOkfConformance", () => {
  test("a conformant chapter passes with no problems", () => {
    const c = chapter({ node_id: "A", title: "Valid", type: "Design Guidance", slug: "valid" });
    const doc = document([volume({ volume_id: "v", chapters: [c] })]);

    const result = checkOkfConformance({
      index: doc,
      chapters: [oc({ slug: "valid", node_id: "A" })],
      volumes: [ov({ volume_id: "v" })],
      artifacts,
    });

    expect(result.checkId).toBe("okf-conformance");
    expect(result.requiresModel).toBe(false);
    expect(result.findings).toHaveLength(0);
  });

  test("a chapter missing type is flagged", () => {
    const c = chapter({ node_id: "A", title: "Untyped", slug: "untyped" });
    const doc = document([volume({ volume_id: "v", chapters: [c] })]);

    const result = checkOkfConformance({
      index: doc,
      chapters: [oc({ slug: "untyped", node_id: "A", type: undefined })],
      volumes: [ov({ volume_id: "v" })],
      artifacts,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.code).toBe("okf-missing-type");
    expect(result.findings[0]!.severity).toBe("error");
    expect(result.findings[0]!.nodeIds).toEqual(["A"]);
  });

  test("multiple chapters: only those missing type are flagged", () => {
    const good = chapter({ node_id: "A", title: "Good", type: "Reference", slug: "good" });
    const bad = chapter({ node_id: "B", title: "Bad", slug: "bad" });
    const doc = document([volume({ volume_id: "v", chapters: [good, bad] })]);

    const result = checkOkfConformance({
      index: doc,
      chapters: [
        oc({ slug: "good", node_id: "A", type: "Reference" }),
        oc({ slug: "bad", node_id: "B", type: undefined }),
      ],
      volumes: [ov({ volume_id: "v" })],
      artifacts,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.nodeIds).toEqual(["B"]);
  });

  test("a valid Attested Computation chapter passes", () => {
    const c = chapter({
      node_id: "A",
      title: "Revenue computation",
      slug: "revenue",
    });
    const doc = document([volume({ volume_id: "v", chapters: [c] })]);

    const result = checkOkfConformance({
      index: doc,
      chapters: [
        oc({
          slug: "revenue",
          node_id: "A",
          type: "Attested Computation",
          attestedComputation: {
            runtime: "bigquery",
            parameters: [{ name: "year", type: "integer", required: true }],
            computation: "references/computations/revenue.sql",
            executor: { resource: "references/skills/run-on-bq.md", receipt: ["job_id"] },
            attester: { resource: "references/attesters/revenue.py" },
          },
        }),
      ],
      volumes: [ov({ volume_id: "v" })],
      artifacts,
    });
    expect(result.findings).toHaveLength(0);
  });

  test("an Attested Computation missing runtime is flagged", () => {
    const c = chapter({
      node_id: "A",
      title: "Bad computation",
      slug: "badcomp",
    });
    const doc = document([volume({ volume_id: "v", chapters: [c] })]);

    const result = checkOkfConformance({
      index: doc,
      chapters: [
        oc({
          slug: "badcomp",
          node_id: "A",
          type: "Attested Computation",
          attestedComputation: {
            runtime: "",
            parameters: [],
            executor: { resource: "", receipt: [] },
            attester: { resource: "" },
          },
        }),
      ],
      volumes: [ov({ volume_id: "v" })],
      artifacts,
    });

    expect(result.findings.map((f) => f.code)).toContain("okf-attested-missing-runtime");
  });

  test("an Attested Computation missing attestedComputation entirely is flagged", () => {
    const c = chapter({
      node_id: "A",
      title: "Missing fields",
      slug: "missingac",
    });
    const doc = document([volume({ volume_id: "v", chapters: [c] })]);

    const result = checkOkfConformance({
      index: doc,
      chapters: [oc({ slug: "missingac", node_id: "A", type: "Attested Computation" })],
      volumes: [ov({ volume_id: "v" })],
      artifacts,
    });

    expect(result.findings[0]!.code).toBe("okf-attested-missing-fields");
  });

  test("an Attested Computation with bad parameters is flagged", () => {
    const c = chapter({
      node_id: "A",
      title: "Bad params",
      slug: "badparams",
    });
    const doc = document([volume({ volume_id: "v", chapters: [c] })]);

    const result = checkOkfConformance({
      index: doc,
      chapters: [
        oc({
          slug: "badparams",
          node_id: "A",
          type: "Attested Computation",
          attestedComputation: {
            runtime: "python",
            parameters: [
              { name: "", type: "string", required: true },
              { name: "limit", type: "", required: true },
            ],
            executor: { resource: "run.py", receipt: ["result"] },
            attester: { resource: "check.py" },
          },
        }),
      ],
      volumes: [ov({ volume_id: "v" })],
      artifacts,
    });

    const codes = result.findings.map((f) => f.code);
    expect(codes.filter((c) => c === "okf-attested-bad-parameter")).toHaveLength(2);
  });

  test("an Attested Computation with missing executor or attester resource is flagged", () => {
    const c = chapter({
      node_id: "A",
      title: "Missing resources",
      slug: "missingres",
    });
    const doc = document([volume({ volume_id: "v", chapters: [c] })]);

    const result = checkOkfConformance({
      index: doc,
      chapters: [
        oc({
          slug: "missingres",
          node_id: "A",
          type: "Attested Computation",
          attestedComputation: {
            runtime: "postgres",
            parameters: [{ name: "id", type: "uuid", required: true }],
            executor: { resource: "", receipt: [] },
            attester: { resource: "" },
          },
        }),
      ],
      volumes: [ov({ volume_id: "v" })],
      artifacts,
    });

    const codes = result.findings.map((f) => f.code);
    expect(codes).toContain("okf-attested-missing-executor-resource");
    expect(codes).toContain("okf-attested-missing-attester-resource");
  });

  test("missing root index.md okf_version is flagged", () => {
    const c = chapter({ node_id: "A", title: "Good", slug: "good" });
    const doc = document([volume({ volume_id: "v", chapters: [c] })]);
    const result = checkOkfConformance({
      index: doc,
      chapters: [oc({ slug: "good", node_id: "A" })],
      volumes: [ov({ volume_id: "v" })],
      artifacts: { rootIndexOkfVersion: false, logExists: true },
    });
    expect(result.findings.some((f) => f.code === "okf-missing-root-index")).toBe(true);
  });

  test("missing log.md is flagged as warning", () => {
    const c = chapter({ node_id: "A", title: "Good", slug: "good" });
    const doc = document([volume({ volume_id: "v", chapters: [c] })]);
    const result = checkOkfConformance({
      index: doc,
      chapters: [oc({ slug: "good", node_id: "A" })],
      volumes: [ov({ volume_id: "v" })],
      artifacts: { rootIndexOkfVersion: true, logExists: false },
    });
    const logFinding = result.findings.find((f) => f.code === "okf-missing-log");
    expect(logFinding).toBeDefined();
    expect(logFinding!.severity).toBe("warning");
  });

  describe("volumes", () => {
    test("a conformant volume passes with no problems", () => {
      const c = chapter({ node_id: "A", title: "Valid", type: "Design Guidance", slug: "valid" });
      const doc = document([volume({ volume_id: "v", chapters: [c] })]);

      const result = checkOkfConformance({
        index: doc,
        chapters: [oc({ slug: "valid", node_id: "A" })],
        volumes: [ov({ volume_id: "v", title: "My Volume" })],
        artifacts,
      });

      expect(result.findings).toHaveLength(0);
    });

    test("a volume missing type is flagged, and its remaining field checks are skipped", () => {
      const c = chapter({ node_id: "A", title: "Valid", type: "Design Guidance", slug: "valid" });
      const doc = document([volume({ volume_id: "v", chapters: [c] })]);

      const result = checkOkfConformance({
        index: doc,
        chapters: [oc({ slug: "valid", node_id: "A" })],
        volumes: [
          ov({
            volume_id: "v",
            title: "Untyped Volume",
            type: undefined,
            generated: undefined, // would also fail okf-missing-generated if not skipped
            status: "not-a-real-status", // would also fail okf-invalid-status if not skipped
          }),
        ],
        artifacts,
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]!.code).toBe("okf-volume-missing-type");
      expect(result.findings[0]!.severity).toBe("error");
      expect(result.findings[0]!.message).toContain('Volume "Untyped Volume"');
      expect(result.findings[0]!.nodeIds).toEqual(["v"]);
    });

    test("a volume with invalid status is flagged, naming the volume by title", () => {
      const c = chapter({ node_id: "A", title: "Valid", type: "Design Guidance", slug: "valid" });
      const doc = document([volume({ volume_id: "v", chapters: [c] })]);

      const result = checkOkfConformance({
        index: doc,
        chapters: [oc({ slug: "valid", node_id: "A" })],
        volumes: [ov({ volume_id: "v", title: "Interface Design", status: "not-a-real-status" })],
        artifacts,
      });

      const finding = result.findings.find((f) => f.code === "okf-invalid-status");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("error");
      expect(finding!.message).toContain('Volume "Interface Design"');
      expect(finding!.nodeIds).toEqual(["v"]);
    });

    test("a volume with missing generated is flagged", () => {
      const c = chapter({ node_id: "A", title: "Valid", type: "Design Guidance", slug: "valid" });
      const doc = document([volume({ volume_id: "v", chapters: [c] })]);

      const result = checkOkfConformance({
        index: doc,
        chapters: [oc({ slug: "valid", node_id: "A" })],
        volumes: [ov({ volume_id: "v", title: "Interface Design", generated: undefined })],
        artifacts,
      });

      const finding = result.findings.find((f) => f.code === "okf-missing-generated");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("error");
      expect(finding!.message).toContain('Volume "Interface Design"');
    });

    test("multiple conformant volumes yield no volume findings", () => {
      const c = chapter({ node_id: "A", title: "Valid", type: "Design Guidance", slug: "valid" });
      const doc = document([volume({ volume_id: "v", chapters: [c] })]);

      const result = checkOkfConformance({
        index: doc,
        chapters: [oc({ slug: "valid", node_id: "A" })],
        volumes: [
          ov({ volume_id: "v", title: "One" }),
          ov({ volume_id: "w", title: "Two", status: "stable" }),
        ],
        artifacts,
      });

      expect(result.findings).toHaveLength(0);
    });
  });
});
