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
import { FileMissLog, StructuralIndexer } from "@shadow/indexing";
import { createModel } from "@shadow/model";
import {
  AgenticSearchProvider,
  createRetrievalTransport,
  WebResearchToolAgent,
} from "@shadow/research";
import { ConversationRegistry } from "./conversation-registry.ts";
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

  // `AgenticSearchProvider` is a deliberately separate, narrow session from
  // `researchBriefPort`'s own (see that class's module doc, and
  // `agentic-search-provider.ts`'s) — it is the one thing in this wiring
  // that is allowed to reach Claude Code's built-in `WebSearch`, running on
  // the operator's subscription (D5) since there is no search-provider API
  // key to use instead. It plugs in *underneath* `RetrievalTransport` as a
  // `SearchProvider`, not as a tool `researchBriefPort`'s own session can
  // call, so that session's `WebSearch`/`WebFetch`/`Bash` denial (D23,
  // D2's determinism) stays intact.
  const searchProvider = new AgenticSearchProvider({ sessions: agenticSession });
  const transport = createRetrievalTransport({ mode: "live", live: { search: searchProvider } });
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
    // Without this, `ShadowConversation.getOrCreateSession` (`conversation.ts:324`)
    // falls back to `homedir()/.shadow` for the *agentic session's own*
    // working directory — independent of, and ignoring, `root` above.
    // Verified live: with `SHADOW_HOME` pointed at a temp root, the
    // `ShadowAgent`'s session still wrote into the operator's real home.
    // `test-helpers.ts` already does this (`sessionCwd: root`); this was
    // the one place real wiring diverged from it.
    sessionCwd: root,
  });

  return {
    volumeStore,
    evidenceStore,
    indexer,
    checkWorthinessClassifier,
    entailmentRelevanceJudge,
    claimRestater,
    structuredGenerationPort: structuredGeneration,
    // `FileMissLog` at `<root>/misses.jsonl` — the same file `@shadow/cli`
    // reads/writes (`packages/cli/src/miss-log.ts`'s `missLogPath`). An
    // `InMemoryMissLog` here meant D14's operator backlog ("every
    // not-in-corpus verdict") evaporated on every server restart and was
    // invisible to the CLI regardless — two miss logs for one concept,
    // exactly the split T2.7 already fixed on the CLI side.
    missLog: new FileMissLog(join(root, "misses.jsonl")),
    shadowAgent,
    conversations: new ConversationRegistry(),
  };
}
