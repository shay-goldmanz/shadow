/**
 * Test-only helpers, not part of the public surface (not re-exported from
 * `index.ts`). Mirrors `@shadow/research`'s `test-helpers.ts` and
 * `web-research-tool-agent.test.ts`'s harness pattern.
 */

import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemVolumeStore, toVolumeSlug, type VolumeSlug } from "@shadow/core";
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
} from "@shadow/evidence";
import { StructuralIndexer } from "@shadow/indexing";
import type { Finding, ResearchBrief, ResearchBriefPort, ResearchResult } from "@shadow/research";

// biome-ignore lint/suspicious/noExplicitAny: constructor signatures are inherently heterogeneous
type ErrorConstructor<E> = new (...args: any[]) => E;

/** Await `promise`, assert it rejects, and assert the rejection is an instance of `ctor`. Returns the rejection. */
export async function expectRejection<E>(
  promise: Promise<unknown>,
  ctor: ErrorConstructor<E>,
): Promise<E> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ctor);
    return error as E;
  }
  return expect.unreachable(`expected promise to reject with ${ctor.name}, but it resolved`);
}

export interface VolumeHarness {
  readonly root: string;
  readonly volumeStore: FileSystemVolumeStore;
  readonly evidenceStore: FileSystemEvidenceStore;
  readonly volume: VolumeSlug;
}

/** A fresh temp-dir-backed volume store + evidence store + one created volume, torn down after `fn` returns. */
export async function withVolumeHarness<T>(fn: (harness: VolumeHarness) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "shadow-agent-volume-"));
  try {
    const volumeStore = new FileSystemVolumeStore(root);
    const volume = toVolumeSlug("design-craft");
    await volumeStore.createVolume({ slug: volume, title: "Design Craft" });
    const evidenceStore = new FileSystemEvidenceStore(volumeStore);
    return await fn({ root, volumeStore, evidenceStore, volume });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function freshIndexer(rootDir: string): StructuralIndexer {
  return new StructuralIndexer({ rootDir });
}

// ---------------------------------------------------------------------------
// A fake `ResearchBriefPort`: never touches the network, but writes real,
// witnessed sources into the evidence ledger (`putSourceFromRetrieval`,
// D23) so the `sourceId`s it hands back resolve exactly like a real
// `WebResearchToolAgent`'s would.
// ---------------------------------------------------------------------------

export interface FakeFindingSpec {
  readonly text: string;
  readonly quote: string;
}

export type FakeResearchResponder = (
  brief: ResearchBrief,
  context: { readonly callIndex: number },
) => readonly FakeFindingSpec[];

export class FakeResearchBriefPort implements ResearchBriefPort {
  readonly briefs: ResearchBrief[] = [];
  /**
   * Every `ResearchResult` this fake has produced, indexed by call order —
   * lets a test's scripted model responder read back the real `sourceId`s a
   * later turn must cite. Written by call index (`results[index] = ...`),
   * not appended on completion, so this stays call-ordered even when
   * multiple `research()` calls are in flight concurrently (T0.2) and settle
   * in a different order than they started.
   */
  readonly results: ResearchResult[] = [];
  private callIndex = 0;

  constructor(
    private readonly evidenceStore: EvidenceStore,
    private readonly respond: FakeResearchResponder,
  ) {}

  async research(brief: ResearchBrief): Promise<ResearchResult> {
    this.briefs.push(brief);
    const index = this.callIndex++;
    const specs = this.respond(brief, { callIndex: index });

    const findings: Finding[] = [];
    const sources: ResearchResult["sources"][number][] = [];

    for (const [i, spec] of specs.entries()) {
      const url = `https://example.test/fake-source-${index}-${i}`;
      const source = await this.evidenceStore.putSourceFromRetrieval(
        brief.volume,
        {
          requestedUrl: url,
          finalUrl: url,
          httpStatus: 200,
          contentType: "text/plain",
          bytes: new TextEncoder().encode(spec.quote),
          extractedText: spec.quote,
          retrievedAt: "2026-08-11T00:00:00.000Z",
          transport: "fixture",
        },
        {
          title: `Fake source for: ${brief.goal}`,
          agent: "test/fake-research-brief-port",
          query: brief.goal,
          authority: { tier: "secondary", rationale: "test fixture" },
          volatility: "unknown",
        },
      );
      sources.push(source);
      findings.push({ text: spec.text, citations: [{ sourceId: source.id, quote: spec.quote }] });
    }

    const result: ResearchResult = { findings, sources };
    this.results[index] = result;
    return result;
  }
}

// ---------------------------------------------------------------------------
// Scripted fakes for the three Tier 2 ports the CoE audit needs.
// ---------------------------------------------------------------------------

/** Always says every unmarked sentence is narrative (`checkRequired: false`) — the common case for tests that aren't specifically exercising C1b. */
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
