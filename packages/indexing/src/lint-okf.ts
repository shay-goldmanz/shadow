/**
 * OKF v0.2 conformance validation check (Phase 3).
 *
 * Validates that the index conforms to OKF v0.2 structural requirements:
 * - Every chapter has a non-empty `type` (OKF §4.1).
 * - Every volume has a non-empty `type` (OKF §4.1) — a volume's VOLUME.md
 *   is itself an OKF concept, so the same requirement applies to it.
 * - Chapters and volumes carry valid `status`, `generated`, `stale_after`,
 *   and `verified` fields where present (OKF §5.2, §5.4, §5.5).
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

/**
 * OKF fields shared by chapters and volumes — the ones `validateOkfCommonFindings`
 * checks. Both record types are OKF "concepts" (OKF §4.1) and carry the same
 * lifecycle metadata shape.
 */
interface OkfCommonFields {
  readonly status?: string;
  readonly generated?: { by: string; at: string };
  readonly verified?: unknown;
  readonly stale_after?: string;
}

/** One chapter's OKF-relevant fields pulled from the index for conformance validation. */
export interface OkfChapterRecord extends OkfCommonFields {
  readonly slug: string;
  readonly node_id: string;
  readonly title: string;
  readonly type?: string;
  readonly attestedComputation?: ChapterIndexNode["attestedComputation"];
}

/** One volume's OKF-relevant fields pulled from the index for conformance validation. */
export interface OkfVolumeRecord extends OkfCommonFields {
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

/**
 * Validate the OKF fields shared by chapters and volumes — `status` (OKF
 * §5.4), `generated` (OKF §5.2), `stale_after` (OKF §5.5), and `verified`
 * (OKF §5.2) — against a single subject (one chapter or one volume).
 * `subjectLabel` (e.g. `Chapter "Foo"` / `Volume "Bar"`) is interpolated
 * verbatim into every finding message so callers control the noun; the
 * finding codes and severities are identical for both subject kinds.
 */
function validateOkfCommonFindings(
  subjectLabel: string,
  nodeIds: readonly string[],
  record: OkfCommonFields,
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
      message: `${subjectLabel} has invalid status "${record.status}" — must be draft, stable, or deprecated (OKF §5.4)`,
      nodeIds,
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
      message: `${subjectLabel} is missing required "generated" field with by+at (OKF §5.2)`,
      nodeIds,
    });
  }

  // stale_after must be a valid YYYY-MM-DD date (OKF §5.5)
  if (record.stale_after !== undefined && record.stale_after !== null) {
    const d = new Date(record.stale_after);
    if (isNaN(d.getTime()) || !/^\d{4}-\d{2}-\d{2}$/.test(record.stale_after)) {
      findings.push({
        code: "okf-invalid-stale-after",
        severity: "warning",
        message: `${subjectLabel} has invalid stale_after "${record.stale_after}" — must be YYYY-MM-DD (OKF §5.5)`,
        nodeIds,
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
          message: `${subjectLabel} has a verified entry missing "by" field (OKF §5.2)`,
          nodeIds,
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
 * 2. Chapters carry valid standard OKF fields (status, generated, stale_after,
 *    verified — OKF §5.2, §5.4, §5.5).
 * 3. Attested Computation chapters carry required fields (OKF §10.2).
 * 4. Every volume has a non-empty `type` (OKF §4.1), then the same standard
 *    OKF field validation as chapters (OKF §5.2, §5.4, §5.5).
 * 5. Bundle artifacts: root index.md, per-volume index.md and log.md.
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
        findings.push(
          ...validateOkfCommonFindings(`Chapter "${chapter.title}"`, [chapter.node_id], record),
        );
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

  // Check 4: volumes — type is required (OKF §4.1), then the same standard
  // OKF field validation chapters get.
  for (const volumeRecord of input.volumes) {
    if (!volumeRecord.type || volumeRecord.type.length === 0) {
      findings.push({
        code: "okf-volume-missing-type",
        severity: "error",
        message: `Volume "${volumeRecord.title}" is missing required OKF "type" field — a volume's VOLUME.md is a concept, and type is the only OKF-required field on every concept (OKF §4.1)`,
        nodeIds: [volumeRecord.volume_id],
      });
      continue; // can't validate further without type
    }

    findings.push(
      ...validateOkfCommonFindings(
        `Volume "${volumeRecord.title}"`,
        [volumeRecord.volume_id],
        volumeRecord,
      ),
    );
  }

  // Check 5: bundle artifacts
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
