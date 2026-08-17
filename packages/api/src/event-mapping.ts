/**
 * The ShadowEvent -> wire SSE mapping (`docs/API.md`'s Chat SSE table),
 * factored out of `handlers/chat.ts` (T2.2) so the exact same mapping code
 * drives both the live path (`chat.ts`, today) and replay (`GET
 * /api/sessions/:id/events`, T2.7 — this module only needs to exist for
 * that; T2.7 wires the endpoint).
 *
 * Two concerns live here, deliberately kept separate:
 *
 * 1. **Stamping** (`StoredEventStamper`) — turns one turn's raw
 *    `ShadowEvent`s into `@shadow/sessions`' `StoredSessionEvent` shapes.
 *    The only real work is brief-id correlation: `research-started` mints
 *    `briefId = "<turnId>/brief-<n>"` and remembers it against the
 *    `ResearchBrief` object by identity; `research-completed`/`-failed`
 *    look the same object up. This *has* to happen here, at the point
 *    where the raw `ShadowEvent`s are still flowing and the same
 *    `ResearchBrief` reference is still shared across started/completed/
 *    failed (`@shadow/agent`'s `conversation.ts`, `runResearchDirectives`)
 *    — a stored, replayed brief has already round-tripped through JSON and
 *    lost that identity, which is exactly why the id has to be *stored*,
 *    not re-derived on read (see `@shadow/sessions`' `events.ts`). One
 *    `StoredEventStamper` per turn (`turnId`-scoped, so ids mint uniquely
 *    per turn even if two turns each see a "brief-1") is the seam T2.5's
 *    `SessionService` drops into its tee loop directly.
 *
 * 2. **Wire mapping** (`wireEventsFromStored` / `wireEventsForLive`) — pure
 *    functions from one `StoredSessionEvent` to zero or more wire SSE
 *    events. Pure and stateless on purpose: replay (T2.7) calls
 *    `wireEventsFromStored` directly over events read back from the store;
 *    the live path calls `wireEventsForLive`, which is identical except it
 *    suppresses `assistant-message` (see that function's doc for why).
 *
 * `text-delta` is conspicuously absent from both: it is the one
 * `ShadowEvent` `@shadow/sessions` never stores (`events.ts`'s
 * `NonDeltaAgentEvent`), so it has no `StoredSessionEvent` shape to stamp
 * or map here. The live path streams it straight through to the wire
 * itself, chunk by chunk, exactly as `chat.ts` always has; replay
 * reconstructs the same text as a single delta from the stored
 * `assistant-message`, via `wireEventsFromStored`'s `assistant-message`
 * case.
 *
 * ## Mapping ShadowEvent -> docs/API.md's SSE table
 *
 * Not one-to-one; see each `case` below for the specific gap. Summary:
 * `operator-turn-recorded` and `assistant-message` (on the live path) are
 * dropped (no doc row; `assistant-message` is redundant there with the
 * `text` deltas that already sum to it — but see `wireEventsForLive`, it's
 * *not* dropped for replay). `research-failed` and `chapter-published` /
 * `chapter-rejected` have no doc row but are real `ShadowEvent`s Shadow
 * actually emits, so — per instruction to follow the real shape rather
 * than invent nothing — they are forwarded as `research.failed` /
 * `chapter.published` / `chapter.rejected`, dot-named to match the table's
 * own convention. `chapter.restated` (D9's visibility requirement) is
 * synthesized: `chapter-audit`'s `repairs[]` is the only place a
 * `RepairDecision` appears in `ShadowEvent`, so one `chapter.restated` is
 * unpacked per decision. `indexed` is never emitted for chat (see the
 * `chapter-audit` case below for why that's a real gap, not an oversight).
 * `operator` is new (T2.2) — no `ShadowEvent` produces it; it comes from
 * the store-level `operator-message` record, which the live path (`chat.ts`)
 * synthesizes itself at the start of every turn (see `operatorMessageEvent`).
 */

import type { ShadowEvent } from "@shadow/agent";
import type { ResearchBrief } from "@shadow/research";
import type {
  AgentStoredEvent,
  OperatorMessageEvent,
  StoredSessionEvent,
  TurnBoundaryEndReason,
  TurnBoundaryEvent,
} from "@shadow/sessions";

/** One wire SSE event: `event: <name>` / `data: <json>` (`sse.ts`'s `encodeSseEvent` shape, pre-encoding). */
export interface WireEvent {
  readonly event: string;
  readonly data: unknown;
}

/** `ShadowEvent` minus `text-delta` — the only variants a `StoredEventStamper` ever stamps. `@shadow/sessions` never stores deltas (see this module's doc). */
export type StampableAgentEvent = Exclude<ShadowEvent, { readonly type: "text-delta" }>;

/**
 * Assigns/stamps `briefId`s onto one turn's `ShadowEvent`s and produces the
 * `StoredSessionEvent` shape T2.5's tee will append to the store. Scoped to
 * a single turn: construct one per turn (`new StoredEventStamper(turnId)`),
 * never share across turns — that's both what makes `briefId`s unique
 * across turns (the `turnId` prefix) and what keeps the `research-started`
 * -> `research-completed`/`-failed` identity correlation correct (a
 * `ResearchBrief` object never crosses a turn boundary; per-turn state is
 * therefore never enough to accidentally cross-correlate two turns'
 * briefs).
 */
export class StoredEventStamper {
  private readonly briefIds = new WeakMap<ResearchBrief, string>();
  private briefCounter = 0;
  /**
   * Counts lookup misses (review #9) — separate from `briefCounter` so a
   * miss's placeholder id never collides with a real `research-started`
   * brief's id, and so two misses in the same turn don't collide with each
   * other either. A stored `brief-unknown` (with no suffix, the old
   * behavior) is *permanent* replay corruption the moment a second miss
   * ever happens in the same turn: both would render as literally the same
   * `briefId`, indistinguishable on replay forever after — this package
   * never rewrites `events.jsonl` once written.
   */
  private missCounter = 0;

  constructor(private readonly turnId: string) {}

  /**
   * Stamps one raw agent event into its stored shape. Research events gain
   * a `briefId`: `research-started` mints a fresh one and remembers it
   * against `event.brief` by object identity; `research-completed` /
   * `research-failed` look up the same object. A lookup miss (a brief this
   * stamper never saw `research-started` for — shouldn't happen given
   * `@shadow/agent`'s emission order, but the stamper doesn't assume it)
   * falls back to a stable, per-miss-unique placeholder rather than
   * throwing (review #9: `chat.ts`'s pre-T2.2 `?? "unknown"` fallback,
   * de-collided and logged) — non-throwing because losing one brief's
   * correlation should not sink the rest of the turn's events, but logged
   * because a miss is never expected and worth a human noticing rather than
   * silently disappearing into an indistinguishable placeholder.
   */
  stampAgentEvent(event: StampableAgentEvent): AgentStoredEvent {
    switch (event.type) {
      case "research-started": {
        const briefId = `${this.turnId}/brief-${++this.briefCounter}`;
        this.briefIds.set(event.brief, briefId);
        return { ...event, briefId };
      }
      case "research-completed":
      case "research-failed": {
        const known = this.briefIds.get(event.brief);
        if (known !== undefined) {
          return { ...event, briefId: known };
        }
        const briefId = `${this.turnId}/brief-unknown-${++this.missCounter}`;
        console.warn(
          `StoredEventStamper: no research-started brief found for a "${event.type}" event ` +
            `(turn ${this.turnId}) — stamping stable placeholder briefId "${briefId}" instead. ` +
            "This should not happen given @shadow/agent's emission order; a stored placeholder " +
            "is permanent (events.jsonl is never rewritten), so this is worth investigating.",
        );
        return { ...event, briefId };
      }
      default:
        return event;
    }
  }
}

/** Builds the store-level `operator-message` record (`@shadow/sessions`' `events.ts`) — the user bubble. `@shadow/agent` never emits this; `@shadow/api` synthesizes it at the point a turn starts (live: `chat.ts`, before the first agent event; stored: T2.5's tee, same point). */
export function operatorMessageEvent(text: string): OperatorMessageEvent {
  return { type: "operator-message", text };
}

/** Builds the store-level `turn-boundary(started)` record. T2.5 appends this at run start, ahead of every event the turn itself produces. */
export function turnBoundaryStarted(): TurnBoundaryEvent {
  return { type: "turn-boundary", phase: "started" };
}

/**
 * Builds the store-level `turn-boundary(ended)` record. `endReason` codes
 * `"completed"` / `"interrupted"` carry no extra fields; `"error"` carries
 * `message`/`code` — the only place a *thrown* failure (not an
 * agent-emitted `{ type: "error" }` `ShadowEvent`, which is already an
 * ordinary `AgentStoredEvent`) survives for replay, per `@shadow/sessions`'
 * `events.ts`.
 */
export function turnBoundaryEnded(
  endReason: TurnBoundaryEndReason,
  error?: { readonly message: string; readonly code: string },
): TurnBoundaryEvent {
  if (endReason === "error") {
    if (!error) {
      throw new Error("turnBoundaryEnded('error', ...) requires message/code");
    }
    return { type: "turn-boundary", phase: "ended", endReason: "error", ...error };
  }
  return { type: "turn-boundary", phase: "ended", endReason };
}

/**
 * Build-breaking completeness guard (F5 review fix). Every `type` a
 * `StoredSessionEvent` can carry *except* `UnknownStoredEvent`'s (a
 * deliberately open `string`, forward compat for a `type` this build
 * doesn't recognize — see `events.ts`) must have an entry here, or this
 * fails to typecheck. `AgentStoredEvent["type"]` already covers everything
 * `@shadow/agent`'s `ShadowEvent` union produces (minus `text-delta`, which
 * has no stored shape at all — see this module's doc); `operator-message`
 * and `turn-boundary` are the two store-level kinds the agent layer never
 * emits, added explicitly since `AgentStoredEvent` doesn't include them.
 *
 * The moment `@shadow/sessions`' `events.ts` grows a new `ShadowEvent`
 * variant, this `satisfies` fails to compile — right here, not silently at
 * the `switch`'s `default` case below — until the switch actually handles
 * it, for BOTH the live and replay paths at once (they share this one
 * switch). Without this guard, a new variant fell through to `default`
 * (dropped, not mapped) on every path, with nothing forcing a human to
 * notice before shipping.
 */
export const MAPPED_STORED_EVENT_TYPES = {
  "operator-message": true,
  "operator-turn-recorded": true,
  "assistant-message": true,
  "research-started": true,
  "research-completed": true,
  "research-failed": true,
  "chapter-drafted": true,
  "chapter-audit": true,
  "chapter-published": true,
  "chapter-rejected": true,
  error: true,
  "turn-boundary": true,
} satisfies Record<AgentStoredEvent["type"] | "operator-message" | "turn-boundary", true>;

/**
 * The full stored -> wire mapping. Used by replay (T2.7) directly, and by
 * the live path via `wireEventsForLive` (below). Pure: no state, no
 * side effects — same `StoredSessionEvent` in always produces the same
 * `WireEvent[]` out, which is what makes "live vs replay of the same
 * stored sequence produce identical wire sequences" checkable at all.
 */
export function wireEventsFromStored(event: StoredSessionEvent): readonly WireEvent[] {
  switch (event.type) {
    case "operator-message":
      // T2.2's new wire event — the user bubble. Live: emitted once per
      // turn, at turn start. Replay: once per stored `operator-message`
      // record. Identical either way, so no live/replay split needed here.
      return [{ event: "operator", data: { text: event.text } }];

    case "operator-turn-recorded":
      // No doc row — internal bookkeeping (the evidence-ledger sourceId
      // for the operator's own transcript source) the operator doesn't
      // need to see; it's implied by having sent the message at all.
      return [];

    case "assistant-message":
      // Replay-only in practice (see `wireEventsForLive`): one `text`
      // event carrying the full accumulated string, reconstructing exactly
      // what the live path's per-chunk `text-delta`s summed to.
      return [{ event: "text", data: { delta: event.text } }];

    case "research-started":
      return [{ event: "research.started", data: { briefId: event.briefId, brief: event.brief } }];

    case "research-completed": {
      // `event` narrows to the `research-completed` variant *unioned with*
      // `UnknownStoredEvent` here — `UnknownStoredEvent.type: string`
      // overlaps every string literal a `switch` narrows on, so a plain
      // `case` doesn't exclude it the way `Extract` does. `.result` would
      // otherwise widen to `unknown` (from `UnknownStoredEvent`'s index
      // signature) and block the `.sources`/`.findings` access below —
      // this narrows explicitly to the one real variant instead.
      const research = event as Extract<AgentStoredEvent, { readonly type: "research-completed" }>;
      const out: WireEvent[] = research.result.sources.map((source) => ({
        event: "research.source",
        data: { sourceId: source.id, url: source.url, title: source.title },
      }));
      out.push({
        event: "research.finished",
        data: { briefId: research.briefId, findings: research.result.findings },
      });
      return out;
    }

    case "research-failed":
      // No doc row (the table only has started/source/finished for
      // research) — forwarded anyway: silently dropping a real failure
      // would contradict the table's own stated purpose ("silence reads as
      // failure").
      return [
        {
          event: "research.failed",
          data: { briefId: event.briefId, brief: event.brief, error: event.error },
        },
      ];

    case "chapter-drafted":
      return [{ event: "chapter.drafted", data: { volume: event.volume, chapter: event.chapter } }];

    case "chapter-audit": {
      // Same `UnknownStoredEvent` overlap as `research-completed` above —
      // narrowed explicitly so `.repairs.map` type-checks.
      const audit = event as Extract<AgentStoredEvent, { readonly type: "chapter-audit" }>;
      // D9: what Shadow softened, and why, stays visible. One
      // `chapter.restated` per `RepairDecision`, emitted before the
      // summary `audit` event they contributed to.
      const out: WireEvent[] = audit.repairs.map((repair) => ({
        event: "chapter.restated",
        data: {
          claim: repair.label,
          from: repair.from,
          to: repair.to,
          reason: repair.reason,
          outcome: repair.outcome,
        },
      }));
      // `docs/API.md`'s `audit: { chapter, verdict, findings }` names
      // fields `ShadowEvent`'s `chapter-audit` doesn't carry (no
      // `AuditVerdict`, no per-claim findings — only `passed` and
      // `repairs`; the issue list arrives separately, on
      // `chapter-published`/`chapter-rejected`). Forwarded with the real
      // fields rather than a fabricated shape.
      out.push({
        event: "audit",
        data: {
          volume: audit.volume,
          chapter: audit.chapter,
          passed: audit.passed,
          repairs: audit.repairs,
        },
      });
      return out;
    }

    case "chapter-published":
      // No doc row. `indexed: { volume, stats }` is what the table has
      // here instead, but `@shadow/agent`'s `publishChapter` discards the
      // `Indexer.reindex` result it triggers internally
      // (`packages/agent/src/publish.ts`), so there is no `stats` to
      // report without either changing `@shadow/agent` (outside this
      // package's boundary) or re-running `indexer.reindex` here — which
      // would reindex twice and duplicate domain logic that belongs in one
      // place. `chapter.published` already tells the operator the reindex
      // succeeded (`publishChapter` only reindexes on a passing verdict).
      return [
        { event: "chapter.published", data: { volume: event.volume, chapter: event.chapter } },
      ];

    case "chapter-rejected":
      return [
        {
          event: "chapter.rejected",
          data: { volume: event.volume, chapter: event.chapter, issues: event.issues },
        },
      ];

    case "error":
      // `docs/API.md`: "terminal for this turn." `ShadowEvent`'s `error`
      // carries only a string, no stable code — this isn't one of the
      // typed pillar errors `error-mapping.ts` maps, it's Shadow's own
      // turn narrating its own failure. Terminating the stream on this is
      // the caller's job (it owns the SSE controller); this module only
      // maps the shape.
      return [{ event: "error", data: { message: event.error, code: "shadow_turn_error" } }];

    case "turn-boundary":
      // No wire representation (yet) — `docs/API.md`'s SSE table has no
      // row for it. Store-level bookkeeping only (T2.1/T2.5).
      return [];

    default:
      // `UnknownStoredEvent` (forward compat — a `type` this build doesn't
      // recognize) has no known wire shape to map to. Dropped rather than
      // forwarded raw: an unrecognized record was written by code newer
      // than this build, and forwarding it verbatim as if it had a stable
      // wire contract would be a promise this build cannot keep.
      return [];
  }
}

/**
 * The live path's wire mapping: identical to `wireEventsFromStored` except
 * `assistant-message` maps to nothing. The live path already streamed that
 * exact text to the wire as `text-delta`s, chunk by chunk, as `@shadow/agent`
 * produced them (`chat.ts` sends those directly — `text-delta` has no
 * stored shape at all, see this module's doc); mapping the *stored*
 * `assistant-message` through as well would double-send the same text.
 * Replay has no such live history to lean on — nothing has been sent to
 * *this* reader yet — so `wireEventsFromStored` is what turns the ONE
 * stored `assistant-message` back into a single `text` delta there.
 */
export function wireEventsForLive(event: StoredSessionEvent): readonly WireEvent[] {
  if (event.type === "assistant-message") return [];
  return wireEventsFromStored(event);
}

/**
 * The `text-delta` bus message -> wire event mapping — the one raw
 * `ShadowEvent` this module otherwise never sees (neither
 * `wireEventsFromStored` nor `wireEventsForLive` takes one; see this
 * module's doc for why `@shadow/sessions` never stores it). Both live
 * viewers (`chat.ts`, the turn's own enqueuer) and T2.7's replay+follow
 * (any session-wide subscriber) forward `SessionBusMessage`'s `text-delta`
 * case through this one function, so a chunk reads identically on the wire
 * no matter which viewer receives it.
 */
export function textDeltaWireEvent(text: string): WireEvent {
  return { event: "text", data: { delta: text } };
}

/**
 * If `event` is a `turn-boundary(ended, error)` record, the ONE place a
 * *thrown* failure's message/code survive for the wire (see this module's
 * `turn-boundary` case above — `wireEventsFromStored`/`wireEventsForLive`
 * both return `[]` for every `turn-boundary`, on purpose: the boundary
 * record itself has no wire representation in `docs/API.md`'s SSE table).
 * This is the deliberate exception both `chat.ts` (live) and T2.7's
 * replay+follow need to synthesize identically, so it lives here once
 * instead of being hand-rolled twice. `undefined` for every other
 * `turn-boundary` phase/endReason (`started`, `ended/completed`,
 * `ended/interrupted`) — nothing to do for those.
 */
export function errorEventForBoundary(event: StoredSessionEvent): WireEvent | undefined {
  if (event.type !== "turn-boundary") return undefined;
  // Same `UnknownStoredEvent` overlap `research-completed`/`chapter-audit`
  // already document above: `type: string` on `UnknownStoredEvent` makes a
  // plain `case`/`if` narrow to `TurnBoundaryEvent | UnknownStoredEvent`,
  // not just the real variant, so `.phase`/`.endReason`/`.message`/`.code`
  // would otherwise widen to the index signature's `unknown`.
  const boundary = event as Extract<StoredSessionEvent, { readonly type: "turn-boundary" }>;
  if (boundary.phase !== "ended" || boundary.endReason !== "error") return undefined;
  return { event: "error", data: { message: boundary.message, code: boundary.code } };
}

/**
 * Injects `seq` into a `WireEvent`'s `data` (object spread) — T2.7's wire
 * encoding for `GET /api/sessions/:id/events`: every event derived from a
 * `StoredEventRecord` carries `data.seq` set to that record's `seq`,
 * identically whether it arrived via replay or via the live tail, which is
 * what makes `seq` usable as a reconnect cursor (`?fromSeq=`) regardless of
 * which path delivered the last event a client saw. Scoped to that one
 * endpoint's own wire contract, not retrofitted onto `chat.ts`'s
 * `POST /api/chat` stream (a separate, already-shipped wire contract this
 * task has no reason to change). Live `text-delta` chunks
 * (`textDeltaWireEvent`) have no backing record and therefore no `seq` at
 * all — see this module's doc for why `text-delta` is the one `ShadowEvent`
 * `@shadow/sessions` never stores.
 */
export function withSeq(wire: WireEvent, seq: number): WireEvent {
  return { event: wire.event, data: { ...(wire.data as Record<string, unknown>), seq } };
}
