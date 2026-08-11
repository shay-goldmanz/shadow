/**
 * The composition root: the one place `@shadow/api` wires the whole system
 * together for real — every other pillar's concrete implementation is
 * constructed here and nowhere else in this package. Handlers
 * (`handlers/*.ts`) never import a concrete class, only `ApiDeps`'
 * interfaces; that split is what lets `test-helpers.ts` build an
 * equally-complete `ApiDeps` from fakes without touching a single handler.
 *
 * Per T3.3's report, `ShadowAgent` needs: `FileSystemVolumeStore` +
 * `FileSystemEvidenceStore` (`@shadow/core`/`@shadow/evidence`),
 * `StructuralIndexer` (`@shadow/indexing`), `WebResearchToolAgent` as the
 * `ResearchBriefPort` (`@shadow/research`, itself needing a
 * `RetrievalTransport` and the evidence store), the Tier 2
 * `Batched*` adapters (`@shadow/evidence`) over a `StructuredGenerationPort`,
 * and an `AgenticSessionPort` + `StructuredGenerationPort` from
 * `@shadow/model`. All of it lives here.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { ShadowAgent } from "@shadow/agent";
import { FileSystemVolumeStore } from "@shadow/core";
import {
  BatchedCheckWorthinessClassifier,
  BatchedClaimRestater,
  BatchedEntailmentRelevanceJudge,
  FileSystemEvidenceStore,
} from "@shadow/evidence";
import { InMemoryMissLog, StructuralIndexer } from "@shadow/indexing";
import { createModel } from "@shadow/model";
import { createRetrievalTransport, WebResearchToolAgent } from "@shadow/research";
import type { ApiDeps } from "./deps.ts";

export interface BuildRealApiDepsOptions {
  /** The `VolumeStore`/`EvidenceStore` root. @default `~/.shadow` (D4). */
  readonly root?: string;
  /** Model defaults (e.g. `model` name) forwarded to `@shadow/model`'s `createModel`. */
  readonly model?: string;
}

/** Build a fully real `ApiDeps` — live filesystem store, live evidence store, live model ports (subscription auth only, D5), live web retrieval. Used only by `start.ts`; never imported by a test. */
export function buildRealApiDeps(options: BuildRealApiDepsOptions = {}): ApiDeps {
  const root = options.root ?? join(homedir(), ".shadow");

  const volumeStore = new FileSystemVolumeStore(root);
  const evidenceStore = new FileSystemEvidenceStore(volumeStore);
  const indexer = new StructuralIndexer();

  const { structuredGeneration, agenticSession } = createModel({
    structuredGeneration: options.model ? { model: options.model } : undefined,
    agenticSession: options.model ? { model: options.model } : undefined,
  });

  const checkWorthinessClassifier = new BatchedCheckWorthinessClassifier(structuredGeneration);
  const entailmentRelevanceJudge = new BatchedEntailmentRelevanceJudge(structuredGeneration);
  const claimRestater = new BatchedClaimRestater(structuredGeneration);

  const transport = createRetrievalTransport({ mode: "live" });
  const researchBriefPort = new WebResearchToolAgent({
    transport,
    evidenceStore,
    sessions: agenticSession,
  });

  const shadowAgent = new ShadowAgent({
    agenticSessionPort: agenticSession,
    researchBriefPort,
    volumeStore,
    evidenceStore,
    indexer,
    checkWorthinessClassifier,
    entailmentRelevanceJudge,
    claimRestater,
  });

  return {
    volumeStore,
    evidenceStore,
    indexer,
    checkWorthinessClassifier,
    entailmentRelevanceJudge,
    claimRestater,
    structuredGenerationPort: structuredGeneration,
    missLog: new InMemoryMissLog(),
    shadowAgent,
    conversations: new Map(),
  };
}
