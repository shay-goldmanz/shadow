/**
 * `ApiDeps` — the one interface every handler is written against. This is
 * what makes the composition root (`composition.ts`) separable from the
 * handlers (`handlers/*.ts`) and the routing (`router.ts`): a handler never
 * constructs a `FileSystemVolumeStore` or calls `createModel()` itself, it
 * only ever receives `ApiDeps` as a parameter. Tests build a `ApiDeps` from
 * fakes (`@shadow/model`'s exported fakes, a temp-dir `FileSystemVolumeStore`,
 * `@shadow/research`'s `ReplayTransport`) and get a fully working server
 * with no network and no live model — see `test-helpers.ts`.
 */

import type { ShadowAgent } from "@shadow/agent";
import type { VolumeStore } from "@shadow/core";
import type {
  CheckWorthinessClassifier,
  ClaimRestater,
  EntailmentRelevanceJudge,
  EvidenceStore,
} from "@shadow/evidence";
import type { Indexer, MissLogStore } from "@shadow/indexing";
import type { StructuredGenerationPort } from "@shadow/model";
import type { ConversationRegistry } from "./conversation-registry.ts";

/**
 * Every collaborator an `@shadow/api` handler can call into. A strict
 * superset of `@shadow/agent`'s `PublishDeps`, so it can be passed directly
 * wherever `publishChapter` expects one (`handlers/chapters.ts`).
 */
export interface ApiDeps {
  readonly volumeStore: VolumeStore;
  readonly evidenceStore: EvidenceStore;
  readonly indexer: Indexer;
  readonly checkWorthinessClassifier: CheckWorthinessClassifier;
  readonly entailmentRelevanceJudge: EntailmentRelevanceJudge;
  readonly claimRestater: ClaimRestater;
  /** Used only by `GET /api/lint` when it runs online (not `?offline=true`) — the model-backed self-retrieval and contradiction checks. */
  readonly structuredGenerationPort: StructuredGenerationPort;
  readonly missLog: MissLogStore;
  readonly shadowAgent: ShadowAgent;
  /**
   * In-memory registry of live conversations, keyed by the `sessionId` the
   * `session` SSE event hands the client (`handlers/chat.ts`). Reusing the
   * same `ShadowConversation` instance across `POST /api/chat` calls is
   * what makes D6's session reuse actually happen at the HTTP layer — the
   * underlying `AgenticSession` lives inside that instance and is only
   * ever created once. Lost on server restart, same as any other
   * in-process state; `docs/API.md` documents no persistence guarantee for
   * chat sessions, only for volumes (D4).
   *
   * Bounded (`ConversationRegistry`, not a raw `Map`): each conversation now
   * persists its session transcript on disk for as long as it's held (D6's
   * `resume` requires it), so an unbounded registry would leak both memory
   * and disk. See that class's doc for the eviction policy.
   */
  readonly conversations: ConversationRegistry;
}
