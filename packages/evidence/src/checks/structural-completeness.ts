/**
 * C1a — structural completeness (Tier 0, `docs/EVIDENCE.md`): every
 * `[^label]` has a claim record and vice versa; labels unique and never
 * reused; `sourced`/`operator` have non-empty `evidence[]`; `derived` has
 * non-empty `supports[]` with all targets present and no cycles.
 *
 * Pure: takes the chapter body text and its claim sidecar (plus, if the
 * caller has it, the set of labels this chapter has ever retired — see
 * `types.ts`'s `ClaimLabelRetiredEvent` doc for why that's an explicit
 * input rather than something this function looks up itself). No
 * filesystem, no store — fully testable in isolation.
 */

import { parseFootnoteMarkers } from "../footnotes.ts";
import type { Claim, ClaimSidecar } from "../types.ts";
import type { CheckIssue, CheckOutcome, EvidenceCheck } from "./types.ts";

export interface StructuralCompletenessInput {
  readonly chapterBody: string;
  readonly sidecar: ClaimSidecar;
  /** Labels this chapter has used and since retired (deleted claims). Empty/omitted if unknown or this is the chapter's first audit. */
  readonly retiredLabels?: ReadonlySet<string>;
}

function findCycle(claimsByLabel: ReadonlyMap<string, Claim>): string[] | undefined {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const label of claimsByLabel.keys()) color.set(label, WHITE);

  const path: string[] = [];

  function visit(label: string): string[] | undefined {
    color.set(label, GRAY);
    path.push(label);
    const claim = claimsByLabel.get(label);
    if (claim) {
      for (const target of claim.supports) {
        const targetColor = color.get(target);
        if (targetColor === GRAY) {
          const cycleStart = path.indexOf(target);
          return path.slice(cycleStart).concat(target);
        }
        if (targetColor === WHITE) {
          const found = visit(target);
          if (found) return found;
        }
      }
    }
    path.pop();
    color.set(label, BLACK);
    return undefined;
  }

  for (const label of claimsByLabel.keys()) {
    if (color.get(label) === WHITE) {
      const found = visit(label);
      if (found) return found;
    }
  }
  return undefined;
}

/** Run C1a over one chapter. Pure function; see module doc. */
export function checkStructuralCompleteness(input: StructuralCompletenessInput): CheckOutcome {
  const { chapterBody, sidecar } = input;
  const retiredLabels = input.retiredLabels ?? new Set<string>();
  const issues: CheckIssue[] = [];
  const warnings: CheckIssue[] = [];

  const { markers, malformed } = parseFootnoteMarkers(chapterBody);
  for (const bad of malformed) {
    issues.push({
      code: "malformed-label",
      message: `Malformed footnote marker ${bad.raw}: ${bad.reason}`,
    });
  }

  // Duplicate inline markers (same label used more than once as a reference).
  const markerLabelCounts = new Map<string, number>();
  for (const marker of markers) {
    markerLabelCounts.set(marker.label, (markerLabelCounts.get(marker.label) ?? 0) + 1);
  }
  for (const [label, count] of markerLabelCounts) {
    if (count > 1) {
      issues.push({
        code: "duplicate-label",
        message: `Label "${label}" is used by ${count} markers`,
        label,
      });
    }
  }

  const markerLabels = new Set(markerLabelCounts.keys());
  const claimsByLabel = new Map(sidecar.claims.map((c) => [c.label, c] as const));

  // Duplicate claim records (same label appears twice in the sidecar).
  const claimLabelCounts = new Map<string, number>();
  for (const claim of sidecar.claims) {
    claimLabelCounts.set(claim.label, (claimLabelCounts.get(claim.label) ?? 0) + 1);
  }
  for (const [label, count] of claimLabelCounts) {
    if (count > 1) {
      issues.push({
        code: "duplicate-claim-record",
        message: `Claim label "${label}" has ${count} records in the sidecar`,
        label,
      });
    }
  }

  // Every marker has a claim record.
  for (const label of markerLabels) {
    if (!claimsByLabel.has(label)) {
      issues.push({
        code: "orphan-marker",
        message: `Marker "[^${label}]" has no claim record`,
        label,
      });
    }
  }

  // Every claim record has a marker.
  for (const label of claimsByLabel.keys()) {
    if (!markerLabels.has(label)) {
      issues.push({
        code: "orphan-record",
        message: `Claim record "${label}" has no "[^${label}]" marker in the chapter`,
        label,
      });
    }
  }

  // Never-reused-after-delete.
  for (const label of new Set([...markerLabels, ...claimsByLabel.keys()])) {
    if (retiredLabels.has(label)) {
      issues.push({
        code: "reused-label",
        message: `Label "${label}" was previously used and retired; labels must never be reused`,
        label,
      });
    }
  }

  // Marker kind (bare / `=` / `~`) must agree with the claim's declared kind.
  for (const marker of markers) {
    const claim = claimsByLabel.get(marker.label);
    if (claim && claim.kind !== marker.kind) {
      issues.push({
        code: "kind-mismatch",
        message: `Marker "${marker.raw}" implies kind "${marker.kind}" but claim record declares "${claim.kind}"`,
        label: marker.label,
      });
    }
  }

  // Per-claim requirements.
  for (const claim of sidecar.claims) {
    if ((claim.kind === "sourced" || claim.kind === "operator") && claim.evidence.length === 0) {
      issues.push({
        code: "missing-evidence",
        message: `Claim "${claim.label}" (${claim.kind}) has no evidence`,
        label: claim.label,
      });
    }
    if (claim.kind === "derived") {
      if (claim.supports.length === 0) {
        issues.push({
          code: "missing-supports",
          message: `Derived claim "${claim.label}" has no supports[]`,
          label: claim.label,
        });
      }
      for (const target of claim.supports) {
        if (!claimsByLabel.has(target)) {
          issues.push({
            code: "supports-target-missing",
            message: `Derived claim "${claim.label}" supports "${target}", which has no claim record in this chapter`,
            label: claim.label,
          });
        }
      }
    }
  }

  // Cycle detection over the supports[] graph.
  const cycle = findCycle(claimsByLabel);
  if (cycle) {
    issues.push({
      code: "supports-cycle",
      message: `Cycle in supports[]: ${cycle.join(" -> ")}`,
    });
  }

  return {
    checkId: "C1a",
    tier: 0,
    blocking: true,
    passed: issues.length === 0,
    issues,
    warnings,
  };
}

export const structuralCompletenessCheck: EvidenceCheck<StructuralCompletenessInput> = {
  id: "C1a",
  tier: 0,
  blocking: true,
  run: checkStructuralCompleteness,
};
