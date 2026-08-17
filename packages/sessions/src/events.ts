/**
 * The stored-event schema — the shape of `StoredEventRecord.event` on disk
 * in `events.jsonl`. This is the type-level heart of "this package is the
 * only one that knows the storage format" (PLAN.md, T2.1).
 *
 * **Dependency-direction decision.** `StoredSessionEvent` is derived from
 * `@shadow/agent`'s `ShadowEvent` via a **type-only** import
 * (`import type`, required anyway by `verbatimModuleSyntax`) rather than a
 * hand-copied duplicate union. The alternative — redefining the agent's
 * event shapes here from scratch — would drift silently the next time
 * `@shadow/agent` grows or changes a `ShadowEvent` variant, since nothing
 * would fail to compile; deriving via `Exclude`/mapped types instead makes
 * that drift a type error in *this* package the moment it happens.
 *
 * This does add `@shadow/agent` as a workspace dependency, which is only
 * safe because it cannot create a cycle. The dependency graph today is a
 * DAG rooted at `@shadow/core`: `model -> core`; `evidence -> core, model`;
 * `research`/`indexing -> core, evidence, model`; `agent -> core, evidence,
 * indexing, model, research`. Nothing `agent` depends on (transitively)
 * depends on `sessions`, and nothing in the plan's later tiers gives
 * `agent` a reason to import `sessions` — the direction of *use* is the
 * other way (T2.5's `SessionService`, in `@shadow/api`, is what calls both
 * `agent` and `sessions`). So `sessions -> agent` only ever extends the
 * existing DAG by one more leaf (`core <- ... <- agent <- sessions`), the
 * same position `api` already occupies one level up — `api` depending on
 * both `agent` and `sessions` is a diamond, not a cycle. Because the import
 * is type-only, it also costs nothing at runtime: `ShadowEvent` is erased
 * from the compiled output, so no package that depends on `@shadow/sessions`
 * pulls in the agent's (or, transitively, the SDK's) runtime code just for
 * this.
 */

import type { ShadowEvent } from "@shadow/agent";
import type { ChapterSlug, VolumeSlug } from "@shadow/core";

/**
 * `ShadowEvent` minus `text-delta`: the per-turn `assistant-message` event
 * already carries the full accumulated text, so persisting every delta
 * too would be pure redundancy on disk. Replay reconstructs a single
 * synthetic `text-delta` from the stored `assistant-message` — that
 * mapping is `@shadow/api`'s shared event mapper (T2.2), not this
 * package's job; this package only needs to *not store* what replay can
 * regenerate.
 */
type NonDeltaAgentEvent = Exclude<ShadowEvent, { readonly type: "text-delta" }>;

const RESEARCH_EVENT_TYPES = ["research-started", "research-completed", "research-failed"] as const;
type ResearchEventType = (typeof RESEARCH_EVENT_TYPES)[number];

/**
 * Adds a stored `briefId` to the three research events. Assigned at tee
 * time by `@shadow/api` (`briefId = "<turnId>/brief-<n>"`, T2.2) when
 * `research-started` is first stored — `research-completed`/`-failed` for
 * the same brief are correlated to it there too, while the correlation
 * still works by object identity. It has to be *stored*, not recomputed on
 * read, because that identity-based correlation cannot survive a JSON
 * round-trip: two `ResearchBrief` objects deserialized independently from
 * `research-started` and `research-completed` records are structurally
 * equal at best, not referentially the same object, and structural
 * equality is not a safe correlation key if a turn ever issues two
 * brief-identical directives in parallel (T0.2).
 */
type WithBriefId<E> = E extends { readonly type: ResearchEventType }
  ? E & { readonly briefId: string }
  : E;

/** The agent-emitted portion of `StoredSessionEvent`: every real `ShadowEvent` except `text-delta`, with research events carrying a stored `briefId`. */
export type AgentStoredEvent = WithBriefId<NonDeltaAgentEvent>;

/**
 * The user bubble. Appended by `@shadow/api`'s `SessionService` **when the
 * turn starts running**, not when it is enqueued (T2.5) — a turn sitting
 * in the per-session FIFO queue behind another has not yet produced a
 * record at all, so a crash while it's still queued loses the queued
 * message cleanly instead of leaving a `turn-boundary(started)` with no
 * matching `ended` (which would misread on replay as an interrupted turn
 * that never happened). `@shadow/agent` itself never emits this — the
 * closest `ShadowEvent`, `operator-turn-recorded`, only carries the
 * evidence-ledger `sourceId`, not the operator's actual text, and today's
 * live wire path has no user-bubble event at all (`chat.ts` relies on the
 * client echoing its own sent text) — `operator-message` is what makes a
 * second, passive viewer see the same user bubbles a replay would (T2.2).
 */
export interface OperatorMessageEvent {
  readonly type: "operator-message";
  readonly text: string;
}

/** Why a turn's `turn-boundary(ended)` record closed the way it did. */
export type TurnBoundaryEndReason = "completed" | "error" | "interrupted";

/**
 * Brackets one turn. `@shadow/agent`'s `sendMessage` streams `ShadowEvent`s
 * but has no notion of "the turn as a whole" — `AutoTurnBudgetExceededError`
 * and handler-level catches (a thrown `Error`, not a `ShadowEvent`) are
 * exactly the failures that have nowhere else to be recorded, which is why
 * the `ended`/`error` variant below carries `message`/`code`: it is where
 * a thrown error's content survives for replay. An agent-emitted
 * `{ type: "error" }` event (the model's own turn failing mid-stream) is
 * an ordinary member of `AgentStoredEvent` already — this boundary is
 * strictly for failures the agent layer never got a chance to turn into a
 * `ShadowEvent` at all.
 */
export type TurnBoundaryEvent =
  | { readonly type: "turn-boundary"; readonly phase: "started" }
  | { readonly type: "turn-boundary"; readonly phase: "ended"; readonly endReason: "completed" }
  | { readonly type: "turn-boundary"; readonly phase: "ended"; readonly endReason: "interrupted" }
  | {
      readonly type: "turn-boundary";
      readonly phase: "ended";
      readonly endReason: "error";
      readonly message: string;
      readonly code: string;
    };

/**
 * Catch-all for a `type` this build of the package doesn't recognize.
 * Forward compat: an older reader must not drop a record written by a
 * newer writer just because it doesn't know the shape (T2.1's "unknown
 * event types on read are preserved, not dropped"). Structural, like every
 * other on-disk type in this codebase (`readIndex`'s `as T`, `EvidenceStore`'s
 * "trust boundary" casts) — nothing here is runtime-validated, so a known
 * variant is *also* structurally assignable to this one. That's fine: it
 * only matters as the fallback a reader falls through to when `type`
 * doesn't match any case it switches on, e.g. rendering a small
 * "(unrecognized event)" placeholder instead of erroring or vanishing the
 * record.
 */
export interface UnknownStoredEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * `StoredEventRecord.event`'s type: the agent's `ShadowEvent` union minus
 * `text-delta`, research events augmented with a stored `briefId`, plus
 * the two store-level record kinds the agent layer never emits
 * (`operator-message`, `turn-boundary`) and a passthrough for forward
 * compat.
 */
export type StoredSessionEvent =
  | AgentStoredEvent
  | OperatorMessageEvent
  | TurnBoundaryEvent
  | UnknownStoredEvent;

// Re-exported so a consumer of `StoredSessionEvent` (e.g. a mapper
// switching on `event.type` for `chapter-drafted`/`chapter-published`)
// doesn't also need a separate `@shadow/core` import just to name the
// slug types those variants carry.
export type { ChapterSlug, VolumeSlug };
