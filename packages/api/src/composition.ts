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
import { FileSystemRulebookStore, FileSystemVolumeStore } from "@shadow/core";
import {
  BatchedCheckWorthinessClassifier,
  BatchedClaimRestater,
  BatchedEntailmentRelevanceJudge,
  FileSystemEvidenceStore,
} from "@shadow/evidence";
import { FileMissLog, StructuralIndexer } from "@shadow/indexing";
import { createModel, type ModelProvider } from "@shadow/model";
import {
  AgenticSearchProvider,
  createRetrievalTransport,
  UnavailableSearchProvider,
  WebResearchToolAgent,
} from "@shadow/research";
import { RulebookToolAgent } from "@shadow/rulebook";
import { ConversationRegistry } from "./conversation-registry.ts";
import type { ApiDeps } from "./deps.ts";

export interface BuildRealApiDepsOptions {
  /** The `VolumeStore`/`EvidenceStore` root. @default `~/.shadow` (D4). */
  readonly root?: string;
  /** Model defaults (e.g. `model` name) forwarded to `@shadow/model`'s `createModel`. */
  readonly model?: string;
}

/**
 * Resolves `SHADOW_MODEL_PROVIDER` to a `ModelProvider` (D26). Selection is
 * explicit: only the literal `"bedrock"` opts in; anything else — unset,
 * empty, or a typo — is the subscription default, never a fallback.
 */
function resolveModelProvider(value: string | undefined): ModelProvider {
  return value === "bedrock" ? "bedrock" : "claude-code";
}

/** Build a fully real `ApiDeps` — live filesystem store, live evidence store, live model ports (subscription auth only by default, D5/D26), live web retrieval. Used only by `start.ts`; never imported by a test. */
export function buildRealApiDeps(options: BuildRealApiDepsOptions = {}): ApiDeps {
  const root = options.root ?? join(homedir(), ".shadow");

  const volumeStore = new FileSystemVolumeStore(root);
  const evidenceStore = new FileSystemEvidenceStore(volumeStore);
  const indexer = new StructuralIndexer({ rootDir: root });

  const modelProvider = resolveModelProvider(process.env.SHADOW_MODEL_PROVIDER);
  const { structuredGeneration, agenticSession } = createModel({
    provider: modelProvider,
    claudeCode: {
      structuredGeneration: options.model ? { model: options.model } : undefined,
      agenticSession: options.model ? { model: options.model } : undefined,
    },
    // Unset env vars leave both fields undefined, so createModel's own
    // bedrock defaults (AWS_REGION / "us-east-1" for region, the adapter's
    // built-in default model) apply. Read unconditionally; simply unused
    // whenever modelProvider resolves to "claude-code".
    bedrock: {
      model: process.env.SHADOW_BEDROCK_MODEL,
      region: process.env.SHADOW_BEDROCK_REGION,
    },
  });

  const checkWorthinessClassifier = new BatchedCheckWorthinessClassifier(structuredGeneration);
  const entailmentRelevanceJudge = new BatchedEntailmentRelevanceJudge(structuredGeneration);
  const claimRestater = new BatchedClaimRestater(structuredGeneration);

  // Rule books live in their own bundle kind under the same shadow root
  // (`RulebookStore`'s module doc) — not a volume. Its evidence store is a
  // second `FileSystemEvidenceStore` instance scoped over `rulebookStore`
  // rather than `volumeStore`, since a group's claim sidecar/audit/sources
  // are keyed by `(rulebookSlug, groupSlug)`, structurally identical to a
  // volume's `(volume, chapter)` but a genuinely separate directory tree.
  const rulebookStore = new FileSystemRulebookStore(root);
  const rulebookEvidenceStore = new FileSystemEvidenceStore(rulebookStore);

  // Reuses the already-constructed `structuredGeneration` port and the
  // three Tier 2 `Batched*` adapters above rather than building a second
  // set — the rule book pipeline's audit gate (`publishGroup`) needs the
  // exact same Tier 2 ports a chapter's audit does, and there is no reason
  // for two separate instances of each to exist in one process.
  const ruleBookPort = new RulebookToolAgent({
    rulebookStore,
    evidenceStore: rulebookEvidenceStore,
    structuredGeneration,
    checkWorthinessClassifier,
    entailmentRelevanceJudge,
    claimRestater,
  });

  // `AgenticSearchProvider` is a deliberately separate, narrow session from
  // `researchBriefPort`'s own (see that class's module doc, and
  // `agentic-search-provider.ts`'s) — it is the one thing in this wiring
  // that is allowed to reach Claude Code's built-in `WebSearch`, running on
  // the operator's subscription (D5) since there is no search-provider API
  // key to use instead. It plugs in *underneath* `RetrievalTransport` as a
  // `SearchProvider`, not as a tool `researchBriefPort`'s own session can
  // call, so that session's `WebSearch`/`WebFetch`/`Bash` denial (D23,
  // D2's determinism) stays intact.
  //
  // On `bedrock`, `AgenticSearchProvider` would be worse than nothing: it
  // builds a session with `allowedTools: ["WebSearch"]`, but the Bedrock
  // adapter (`@shadow/model`'s `bedrock-agentic-session.ts`) only ever
  // builds tools from `toolServers` and silently ignores any built-in name
  // it doesn't recognize — so that session would run with *no* tools at
  // all, and the model would either hallucinate a result or fail the
  // required-JSON-output contract in a confusing way, never a clean error.
  // `UnavailableSearchProvider` fails loudly and immediately instead — see
  // `SearchUnavailableError`'s doc in `@shadow/research` for the exact
  // operator-facing message.
  const searchProvider =
    modelProvider === "bedrock"
      ? new UnavailableSearchProvider()
      : new AgenticSearchProvider({ sessions: agenticSession });
  const transport = createRetrievalTransport({ mode: "live", live: { search: searchProvider } });
  const researchBriefPort = new WebResearchToolAgent({
    transport,
    evidenceStore,
    sessions: agenticSession,
  });

  const shadowAgent = new ShadowAgent({
    agenticSessionPort: agenticSession,
    researchBriefPort,
    ruleBookPort,
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
    rulebookStore,
    rulebookEvidenceStore,
    conversations: new ConversationRegistry(),
  };
}
