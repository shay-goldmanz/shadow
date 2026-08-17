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
import type { SessionService } from "./session-service.ts";

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
   * Owns session lifecycle (T2.5) — `handlers/chat.ts` enqueues turns
   * through this instead of touching `conversations`/`shadowAgent`
   * directly. See `session-service.ts`'s module doc.
   */
  readonly sessionService: SessionService;
  /**
   * The SAME `ConversationRegistry` instance `sessionService` constructed
   * for itself (`SessionService.registry`), kept on `ApiDeps` only for the
   * callers that predate T2.5 and still need direct access: `start.ts`'s
   * shutdown path (`releaseAll()`). Every session-lifecycle concern now
   * goes through `sessionService` instead — this is a read/shutdown-only
   * handle onto the same cache, not a second registry.
   *
   * Bounded (`ConversationRegistry`, not a raw `Map`): each conversation
   * holds an `AgenticSession` handle for as long as it's registered, so an
   * unbounded registry would leak memory. Eviction only releases that
   * in-memory handle, never the session's on-disk transcript (T2.4/D6b) —
   * see that class's doc for the eviction policy, including how it skips a
   * session with a running/queued turn.
   */
  readonly conversations: ConversationRegistry;
}
