/**
 * Test-only helpers, not part of the public surface (not re-exported from
 * `index.ts`). Mirrors `@shadow/agent`'s `test-helpers.ts` pattern, adapted
 * for rule books: a temp-dir `FileSystemRulebookStore` in place of
 * `FileSystemVolumeStore` — `@shadow/evidence` composes over both via the
 * same `VolumePathResolver` seam, so the harness shape is otherwise
 * identical.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemRulebookStore, toVolumeSlug, type VolumeSlug } from "@shadow/core";
import {
  type CheckWorthinessClassifier,
  type CheckWorthinessInput,
  type CheckWorthinessVerdict,
  type ClaimRestater,
  type EntailmentRelevanceInput,
  type EntailmentRelevanceJudge,
  type EntailmentRelevanceVerdict,
  type EvidenceStore,
  FileSystemEvidenceStore,
  type RestatementCandidateInput,
  type RestatementProposal,
  type SourceRecord,
} from "@shadow/evidence";

export interface RulebookHarness {
  readonly root: string;
  readonly rulebookStore: FileSystemRulebookStore;
  readonly evidenceStore: FileSystemEvidenceStore;
  readonly rulebookSlug: VolumeSlug;
}

/** A fresh temp-dir-backed rule book store + evidence store + one created rule book, torn down after `fn` returns. */
export async function withRulebookHarness<T>(
  fn: (harness: RulebookHarness) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "shadow-rulebook-test-"));
  try {
    const rulebookStore = new FileSystemRulebookStore(root);
    const rulebookSlug = toVolumeSlug("loan-rules");
    await rulebookStore.createRulebook({ slug: rulebookSlug, title: "Loan Rules" });
    const evidenceStore = new FileSystemEvidenceStore(rulebookStore);
    return await fn({ root, rulebookStore, evidenceStore, rulebookSlug });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Witness `text` as a file-transport source (mirrors what `ingestDocument` produces) and return its `SourceRecord`. */
export async function witnessSourceText(
  evidenceStore: EvidenceStore,
  rulebookSlug: VolumeSlug,
  text: string,
): Promise<SourceRecord> {
  return evidenceStore.putSourceFromFile(
    rulebookSlug,
    { path: "/fake/doc.md", bytes: new TextEncoder().encode(text), text, readAt: new Date() },
    {
      title: "Test source document",
      agent: "rulebook-extractor",
      authority: { tier: "primary", rationale: "test fixture" },
      volatility: "unknown",
    },
  );
}

/** Always says every unmarked sentence is narrative (`checkRequired: false`) — a rule-book group's body is always all-bullets, so this is never actually exercised, but `runFullAudit` still requires the port. */
export const alwaysNarrativeClassifier: CheckWorthinessClassifier = {
  classify: async (
    inputs: readonly CheckWorthinessInput[],
  ): Promise<readonly CheckWorthinessVerdict[]> =>
    inputs.map(() => ({ checkRequired: false, rationale: "test fixture: treated as narrative" })),
};

export type EntailmentVerdictFn = (input: EntailmentRelevanceInput) => EntailmentRelevanceVerdict;

/** Always says "supported" / "on-topic" — the happy path. Override with a custom `EntailmentVerdictFn` to script failures. */
export function scriptedEntailmentJudge(
  verdictFor?: EntailmentVerdictFn,
): EntailmentRelevanceJudge {
  const fn: EntailmentVerdictFn =
    verdictFor ??
    (() => ({
      entailment: { status: "supported", rationale: "test fixture: always supported" },
      relevance: { relevance: "on-topic", rationale: "test fixture: always on-topic" },
    }));
  return {
    judge: async (inputs: readonly EntailmentRelevanceInput[]) => inputs.map(fn),
  };
}

export type RestatementProposalFn = (input: RestatementCandidateInput) => RestatementProposal;

export function scriptedClaimRestater(proposalFor: RestatementProposalFn): ClaimRestater {
  return {
    restate: async (inputs: readonly RestatementCandidateInput[]) => inputs.map(proposalFor),
  };
}
