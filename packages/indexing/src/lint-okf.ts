/**
 * OKF v0.2 conformance validation check (Phase 3).
 *
 * Validates that the index conforms to OKF v0.2 structural requirements:
 * - Every chapter has a non-empty `type` (OKF §4.1).
 * - Attested Computation chapters (`type: "Attested Computation"`) carry
 *   the required computation fields: `runtime`, `parameters`, `executor`,
 *   and `attester` (OKF §10.2).
 * - Index files and log files exist and are well-formed (OKF §8, §9).
 *
 * This is a pure check — zero LLM calls, zero network calls. It reads
 * frontmatter fields already present in the index and validates their
 * shape against the OKF spec.
 */

import type { LintCheck, LintCheckResult, LintFinding } from "./lint-types.ts";
import type { ChapterIndexNode, IndexDocument } from "./types.ts";

// ---- Types consumed by lint.ts's LintOptions.okf ----------------------------

/** One chapter's OKF-relevant fields pulled from the index for conformance validation. */
export interface OkfChapterRecord {
  readonly slug: string;
  readonly node_id: string;
  readonly title: string;
  readonly type?: string;
  readonly status?: string;
  readonly generated?: { by: string; at: string };
  readonly verified?: unknown;
  readonly stale_after?: string;
  readonly attestedComputation?: ChapterIndexNode["attestedComputation"];
}

/** One volume's OKF-relevant fields pulled from the index for conformance validation. */
export interface OkfVolumeRecord {
  readonly volume_id: string;
  readonly title: string;
  readonly type?: string;
}

/** File artifacts the OKF conformance check inspects beyond the index. */
export interface OkfBundleArtifacts {
  /** Whether the bundle-root index.md carries `okf_version: "0.2"` (OKF §8, §12). */
  readonly rootIndexOkfVersion: boolean;
  /** Whether the bundle-root log.md exists (OKF §9). */
  readonly logExists: boolean;
}

/** Input bag for the OKF conformance check, wired through `lint.ts`'s `LintOptions.okf`. */
export interface OkfConformanceInput {
  readonly index: IndexDocument;
  readonly chapters: readonly OkfChapterRecord[];
  readonly volumes: readonly OkfVolumeRecord[];
  readonly artifacts: OkfBundleArtifacts;
}

// ---- Standard OKF field validation -----------------------------------------

function validateOkfChapterRecord(
  chapter: { title: string; node_id: string },
  record: OkfChapterRecord,
): LintFinding[] {
  const findings: LintFinding[] = [];

  // status must be draft/stable/deprecated (OKF §5.4)
  if (
    record.status !== undefined &&
    record.status !== "draft" &&
    record.status !== "stable" &&
    record.status !== "deprecated"
  ) {
    findings.push({
      code: "okf-invalid-status",
      severity: "error",
      message: `Chapter "${chapter.title}" has invalid status "${record.status}" — must be draft, stable, or deprecated (OKF §5.4)`,
      nodeIds: [chapter.node_id],
    });
  }

  // generated must have by+at (OKF §5.2)
  if (
    !record.generated ||
    typeof record.generated.by !== "string" ||
    typeof record.generated.at !== "string"
  ) {
    findings.push({
      code: "okf-missing-generated",
      severity: "error",
      message: `Chapter "${chapter.title}" is missing required "generated" field with by+at (OKF §5.2)`,
      nodeIds: [chapter.node_id],
    });
  }

  // stale_after must be a valid YYYY-MM-DD date (OKF §5.5)
  if (record.stale_after !== undefined && record.stale_after !== null) {
    const d = new Date(record.stale_after);
    if (isNaN(d.getTime()) || !/^\d{4}-\d{2}-\d{2}$/.test(record.stale_after)) {
      findings.push({
        code: "okf-invalid-stale-after",
        severity: "warning",
        message: `Chapter "${chapter.title}" has invalid stale_after "${record.stale_after}" — must be YYYY-MM-DD (OKF §5.5)`,
        nodeIds: [chapter.node_id],
      });
    }
  }

  // verified entries must have by+at (OKF §5.2)
  if (record.verified !== undefined && record.verified !== null) {
    const entries = Array.isArray(record.verified) ? record.verified : [record.verified];
    for (const entry of entries) {
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof (entry as Record<string, unknown>).by !== "string"
      ) {
        findings.push({
          code: "okf-invalid-verified-by",
          severity: "error",
          message: `Chapter "${chapter.title}" has a verified entry missing "by" field (OKF §5.2)`,
          nodeIds: [chapter.node_id],
        });
        break;
      }
    }
  }

  return findings;
}

// ---- Attested Computation validation ---------------------------------------

function validateAttestedComputation(
  chapter: { title: string; node_id: string },
  ac: NonNullable<ChapterIndexNode["attestedComputation"]>,
): LintFinding[] {
  const findings: LintFinding[] = [];

  // runtime is required and must be a non-empty string
  if (typeof ac.runtime !== "string" || ac.runtime.length === 0) {
    findings.push({
      code: "okf-attested-missing-runtime",
      severity: "error",
      message: `Attested Computation chapter "${chapter.title}" is missing required "runtime" field (OKF §10.2)`,
      nodeIds: [chapter.node_id],
    });
  }

  // parameters must be a non-empty array
  if (!Array.isArray(ac.parameters) || ac.parameters.length === 0) {
    findings.push({
      code: "okf-attested-missing-parameters",
      severity: "error",
      message: `Attested Computation chapter "${chapter.title}" must have a non-empty "parameters" array (OKF §10.2)`,
      nodeIds: [chapter.node_id],
    });
  } else {
    for (let i = 0; i < ac.parameters.length; i++) {
      const p = ac.parameters[i];
      if (p && typeof p === "object") {
        if (typeof p.name !== "string" || p.name.length === 0) {
          findings.push({
            code: "okf-attested-bad-parameter",
            severity: "error",
            message: `Attested Computation chapter "${chapter.title}" parameter[${i}] is missing "name"`,
            nodeIds: [chapter.node_id],
          });
        }
        if (typeof p.type !== "string" || p.type.length === 0) {
          findings.push({
            code: "okf-attested-bad-parameter",
            severity: "error",
            message: `Attested Computation chapter "${chapter.title}" parameter[${i}] is missing "type"`,
            nodeIds: [chapter.node_id],
          });
        }
        if (typeof p.required !== "boolean") {
          findings.push({
            code: "okf-attested-bad-parameter",
            severity: "error",
            message: `Attested Computation chapter "${chapter.title}" parameter[${i}] is missing "required" boolean`,
            nodeIds: [chapter.node_id],
          });
        }
      }
    }
  }

  // executor.resource is required
  if (!ac.executor || typeof ac.executor !== "object") {
    findings.push({
      code: "okf-attested-missing-executor",
      severity: "error",
      message: `Attested Computation chapter "${chapter.title}" is missing required "executor" field (OKF §10.2)`,
      nodeIds: [chapter.node_id],
    });
  } else {
    if (typeof ac.executor.resource !== "string" || ac.executor.resource.length === 0) {
      findings.push({
        code: "okf-attested-missing-executor-resource",
        severity: "error",
        message: `Attested Computation chapter "${chapter.title}" executor is missing "resource" (OKF §10.2)`,
        nodeIds: [chapter.node_id],
      });
    }
  }

  // attester.resource is required
  if (!ac.attester || typeof ac.attester !== "object") {
    findings.push({
      code: "okf-attested-missing-attester",
      severity: "error",
      message: `Attested Computation chapter "${chapter.title}" is missing required "attester" field (OKF §10.2)`,
      nodeIds: [chapter.node_id],
    });
  } else {
    if (typeof ac.attester.resource !== "string" || ac.attester.resource.length === 0) {
      findings.push({
        code: "okf-attested-missing-attester-resource",
        severity: "error",
        message: `Attested Computation chapter "${chapter.title}" attester is missing "resource" (OKF §10.2)`,
        nodeIds: [chapter.node_id],
      });
    }
  }

  return findings;
}

// ---- Main check ------------------------------------------------------------

/**
 * Run OKF v0.2 conformance validation over a built index plus chapter
 * records, volume records, and file artifacts.
 *
 * Checks performed:
 * 1. Every chapter has a non-empty `type` (OKF §4.1).
 * 2. Attested Computation chapters carry required fields (OKF §10.2).
 * 3. Bundle artifacts: root index.md, per-volume index.md and log.md.
 */
export function checkOkfConformance(input: OkfConformanceInput): LintCheckResult {
  const findings: LintFinding[] = [];
  const typeLookup = new Map(input.chapters.map((c) => [c.node_id, c.type]));
  const acLookup = new Map(
    input.chapters
      .filter((c) => c.attestedComputation)
      .map((c) => [c.node_id, c.attestedComputation!] as const),
  );

  for (const volume of input.index.volumes) {
    for (const chapter of volume.chapters) {
      const type = typeLookup.get(chapter.node_id);

      // Check 1: type must be present and non-empty
      if (!type || type.length === 0) {
        findings.push({
          code: "okf-missing-type",
          severity: "error",
          message: `Chapter "${chapter.title}" is missing required OKF "type" field (OKF §4.1)`,
          nodeIds: [chapter.node_id],
        });
        continue; // can't validate further without type
      }

      // Check 2: validate standard OKF fields
      const record = input.chapters.find((r) => r.node_id === chapter.node_id);
      if (record) {
        findings.push(...validateOkfChapterRecord(chapter, record));
      }

      // Check 3: Attested Computation validation
      if (type === "Attested Computation") {
        const ac = acLookup.get(chapter.node_id);
        if (!ac) {
          findings.push({
            code: "okf-attested-missing-fields",
            severity: "error",
            message: `Attested Computation chapter "${chapter.title}" is missing required computation fields (runtime, parameters, executor, attester) — see OKF §10.2`,
            nodeIds: [chapter.node_id],
          });
        } else {
          findings.push(...validateAttestedComputation(chapter, ac));
        }
      }
    }
  }

  // Check 3: bundle artifacts
  if (!input.artifacts.rootIndexOkfVersion) {
    findings.push({
      code: "okf-missing-root-index",
      severity: "warning",
      message: "Bundle root index.md is missing or does not declare okf_version (OKF §8)",
      nodeIds: [],
    });
  }
  if (!input.artifacts.logExists) {
    findings.push({
      code: "okf-missing-log",
      severity: "warning",
      message: "Bundle root log.md is missing (OKF §9)",
      nodeIds: [],
    });
  }

  return { checkId: "okf-conformance", requiresModel: false, findings };
}

/**
 * The OKF conformance check wrapped as a `LintCheck` — pluggable into
 * `runLintChecks` for composition with other checks.
 */
export const okfConformanceCheck: LintCheck<OkfConformanceInput> = {
  id: "okf-conformance",
  requiresModel: false,
  run: checkOkfConformance,
};
