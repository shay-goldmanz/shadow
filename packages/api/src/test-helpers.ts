/**
 * Test-only harness, not part of the public surface (not re-exported from
 * `index.ts`). Builds a fully working `ApiDeps` — and a running server —
 * from fakes only: a temp-dir `FileSystemVolumeStore`/`FileSystemEvidenceStore`,
 * `@shadow/model`'s exported `FakeAgenticSessionPort`, and small local
 * always-pass Tier 2 fakes (mirrors `@shadow/agent`'s own
 * `test-helpers.ts` pattern, kept local rather than imported so
 * `@shadow/api`'s tests don't reach into another package's private test
 * internals). Offline and deterministic — no network, no live model.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShadowAgent } from "@shadow/agent";
import { FileSystemVolumeStore, type VolumeSlug } from "@shadow/core";
import {
  type CheckWorthinessClassifier,
  type CheckWorthinessInput,
  type CheckWorthinessVerdict,
  type ClaimRestater,
  type EntailmentRelevanceInput,
  type EntailmentRelevanceJudge,
  type EntailmentRelevanceVerdict,
  FileSystemEvidenceStore,
  type RestatementCandidateInput,
  type RestatementProposal,
} from "@shadow/evidence";
import { InMemoryMissLog, StructuralIndexer } from "@shadow/indexing";
import {
  FakeAgenticSessionPort,
  type FakeAgenticTurnResponder,
  FakeStructuredGenerationPort,
} from "@shadow/model";
import type { ResearchBrief, ResearchBriefPort, ResearchResult } from "@shadow/research";
import type { ApiDeps } from "./deps.ts";
import { createServer } from "./server.ts";

/** Always says every unmarked sentence is narrative — the common case for a harness that isn't specifically exercising the check-worthiness sweep. */
export const alwaysNarrativeClassifier: CheckWorthinessClassifier = {
  classify: async (
    inputs: readonly CheckWorthinessInput[],
  ): Promise<readonly CheckWorthinessVerdict[]> =>
    inputs.map(() => ({ checkRequired: false, rationale: "test fixture: treated as narrative" })),
};

export type EntailmentVerdictFn = (input: EntailmentRelevanceInput) => EntailmentRelevanceVerdict;

/** Always says "supported" / "on-topic" unless overridden — the happy path. */
export function scriptedEntailmentJudge(
  verdictFor?: EntailmentVerdictFn,
): EntailmentRelevanceJudge {
  const fn: EntailmentVerdictFn =
    verdictFor ??
    (() => ({
      entailment: { status: "supported", rationale: "test fixture: always supported" },
      relevance: { relevance: "on-topic", rationale: "test fixture: always on-topic" },
    }));
  return { judge: async (inputs) => inputs.map(fn) };
}

export type RestatementProposalFn = (input: RestatementCandidateInput) => RestatementProposal;

export function scriptedClaimRestater(proposalFor: RestatementProposalFn): ClaimRestater {
  return { restate: async (inputs) => inputs.map(proposalFor) };
}

/** A `ResearchBriefPort` that fails loudly if called — for harnesses whose scripted conversation never issues a `shadow:research` directive. */
export const unusedResearchBriefPort: ResearchBriefPort = {
  research(brief: ResearchBrief): Promise<ResearchResult> {
    return Promise.reject(new Error(`unexpected research delegation for goal: ${brief.goal}`));
  },
};

export interface TestHarness {
  readonly root: string;
  readonly deps: ApiDeps;
  readonly server: ReturnType<typeof createServer>;
  readonly baseUrl: string;
  /** The fake session port backing `deps.shadowAgent`'s conversations — for tests that assert on session reuse. */
  readonly sessions: FakeAgenticSessionPort;
}

export interface WithApiOptions {
  /** Scripts Shadow's replies. @default a plain echo. */
  readonly respond?: FakeAgenticTurnResponder;
  readonly researchBriefPort?: ResearchBriefPort;
  readonly checkWorthinessClassifier?: CheckWorthinessClassifier;
  readonly entailmentRelevanceJudge?: EntailmentRelevanceJudge;
  readonly claimRestater?: ClaimRestater;
}

/** A fresh temp-dir-backed `ApiDeps` + running server, torn down after `fn` returns. */
export async function withApi<T>(fn: (harness: TestHarness) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "shadow-api-"));
  try {
    const volumeStore = new FileSystemVolumeStore(root);
    const evidenceStore = new FileSystemEvidenceStore(volumeStore);
    const indexer = new StructuralIndexer();
    const sessions = new FakeAgenticSessionPort();

    const shadowAgent = new ShadowAgent({
      agenticSessionPort: sessions,
      researchBriefPort: unusedResearchBriefPort,
      volumeStore,
      evidenceStore,
      indexer,
      checkWorthinessClassifier: alwaysNarrativeClassifier,
      entailmentRelevanceJudge: scriptedEntailmentJudge(),
      claimRestater: scriptedClaimRestater(() => {
        throw new Error("no claim should need repair in this harness");
      }),
      sessionCwd: root,
    });

    const deps: ApiDeps = {
      volumeStore,
      evidenceStore,
      indexer,
      checkWorthinessClassifier: alwaysNarrativeClassifier,
      entailmentRelevanceJudge: scriptedEntailmentJudge(),
      claimRestater: scriptedClaimRestater(() => {
        throw new Error("no claim should need repair in this harness");
      }),
      structuredGenerationPort: new FakeStructuredGenerationPort(),
      missLog: new InMemoryMissLog(),
      shadowAgent,
      conversations: new Map(),
    };

    const server = createServer(deps, { port: 0, hostname: "localhost" });
    try {
      return await fn({
        root,
        deps,
        server,
        baseUrl: server.url.toString().replace(/\/$/, ""),
        sessions,
      });
    } finally {
      void server.stop(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Like `withApi`, but lets the caller fully script the conversation (a scripted `FakeAgenticSessionPort` responder and, if needed, Tier 2 verdicts) — for chat/SSE tests that need Shadow to emit `shadow:chapter`/`shadow:research` directives. */
export async function withScriptedApi<T>(
  options: WithApiOptions,
  fn: (harness: TestHarness) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "shadow-api-"));
  try {
    const volumeStore = new FileSystemVolumeStore(root);
    const evidenceStore = new FileSystemEvidenceStore(volumeStore);
    const indexer = new StructuralIndexer();
    const sessions = new FakeAgenticSessionPort(options.respond);

    const checkWorthinessClassifier =
      options.checkWorthinessClassifier ?? alwaysNarrativeClassifier;
    const entailmentRelevanceJudge = options.entailmentRelevanceJudge ?? scriptedEntailmentJudge();
    const claimRestater =
      options.claimRestater ??
      scriptedClaimRestater(() => {
        throw new Error("no claim should need repair in this harness");
      });

    const shadowAgent = new ShadowAgent({
      agenticSessionPort: sessions,
      researchBriefPort: options.researchBriefPort ?? unusedResearchBriefPort,
      volumeStore,
      evidenceStore,
      indexer,
      checkWorthinessClassifier,
      entailmentRelevanceJudge,
      claimRestater,
      sessionCwd: root,
    });

    const deps: ApiDeps = {
      volumeStore,
      evidenceStore,
      indexer,
      checkWorthinessClassifier,
      entailmentRelevanceJudge,
      claimRestater,
      structuredGenerationPort: new FakeStructuredGenerationPort(),
      missLog: new InMemoryMissLog(),
      shadowAgent,
      conversations: new Map(),
    };

    const server = createServer(deps, { port: 0, hostname: "localhost" });
    try {
      return await fn({
        root,
        deps,
        server,
        baseUrl: server.url.toString().replace(/\/$/, ""),
        sessions,
      });
    } finally {
      void server.stop(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Create a volume directly through the store (bypassing HTTP) — convenient setup for tests focused on some other endpoint. */
export async function seedVolume(
  deps: ApiDeps,
  slug: VolumeSlug,
  title = "Test Volume",
): Promise<void> {
  await deps.volumeStore.createVolume({ slug, title });
}

export interface ParsedSseEvent {
  readonly event: string;
  readonly data: unknown;
}

/** Reads an SSE `Response` body to completion and parses it into `{event, data}` records, in wire order. */
export async function readAllSseEvents(response: Response): Promise<ParsedSseEvent[]> {
  const text = await response.text();
  const events: ParsedSseEvent[] = [];
  for (const block of text.split("\n\n")) {
    if (block.trim().length === 0) continue;
    let eventName = "message";
    let dataLine: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) eventName = line.slice("event: ".length);
      else if (line.startsWith("data: ")) dataLine = line.slice("data: ".length);
    }
    if (dataLine === undefined) continue;
    events.push({ event: eventName, data: JSON.parse(dataLine) });
  }
  return events;
}
