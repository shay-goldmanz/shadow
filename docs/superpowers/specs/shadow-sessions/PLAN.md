# Shadow Sessions — Implementation Plan

Status: **draft for review** · Supersedes nothing; implements the locked design
(“Shadow Sessions”, 4 tiers) with the refinements agreed in review.
Companion to `docs/DECISIONS.md` (amends D6a — see T2.6).

## What this plan adds to the locked design

The broad design is taken as-is: `@shadow/sessions` as the transcript of
record, SDK `resume` as the primary rehydration path with a summary fallback,
hash-route identity, a conservative injected `RetryPolicy`, per-volume session
management, keep-forever retention. Three refinements from review:

1. **Sessions are entities; turns are jobs.** Once a session is persisted and
   has an id, the in-memory `ShadowConversation` handle stops being the
   identity — it becomes a cache entry for an entity that lives in the store.
   A turn therefore belongs to the *session*, not to the HTTP request that
   started it: client disconnect detaches a viewer, it no longer aborts the
   turn. This is what makes “survive page reloads” true *mid-turn*, not just
   between turns — today `handlers/chat.ts`'s `cancel()` kills the generator
   when the tab goes away, so a reload during a long research turn would lose
   the rest of the turn even with a store.

2. **Concurrency model** (the “can't we just give them ids?” answer — yes):
   - *Across sessions*: fully parallel. After Tier 0 removes the shared
     research agent, sessions share no mutable state — each has its own SDK
     session, its own store directory, its own queue. Nothing to build;
     parallelism is the default.
   - *Within a session*: turns are FIFO-serialized by a per-session queue.
     Two tabs on one session both work — the second `POST /api/chat` enqueues
     rather than racing (`turnsSent`, duplicate `resume` subprocesses) or
     being rejected. The queue is the *only* same-session write path, which is
     also what makes the SDK safe: two concurrent `query()` calls resuming
     the same SDK session id would append to one transcript from two
     subprocesses; the queue makes that unrepresentable. Queue bound: 4
     pending; beyond that `409 turn_queue_busy` (a single operator hammering
     one session past 4 queued turns is a UI bug, not a use case).
   - *Viewers*: any number, read-only, via replay + live follow (T2.7). The
     store's append log plus an in-memory per-session event bus is the
     fan-out point; the `POST /api/chat` SSE response is just the first
     viewer of the turn it enqueued.

3. **Honest cost accounting for Tier 0.** The design's claim that per-brief
   agents skip re-paying the ~18k-token preamble assumes cross-session prompt
   cache hits, which D6's own measurement contradicts. Tier 0 ships with a
   live measurement task (T0.4) and the decision-log amendment records
   whichever number is real. The fix is correct either way; only the recorded
   trade-off changes.

## Package map

| Package | Role in this plan |
|---|---|
| `@shadow/sessions` (new) | Only package that knows the storage format. `SessionStore` port, `FileSystemSessionStore`, stored-event schema, contract suite. |
| `@shadow/model` | First-turn fix in `ClaudeAgentSdkSession`; `RetryPolicy` port + retrying decorator; fakes that can fail transiently. |
| `@shadow/research` | Per-brief agent factory (`ResearchBriefPort` impl). |
| `@shadow/agent` | Parallel research directives; `resume` pass-through in `StartConversationOptions`; dispose split. |
| `@shadow/api` | `SessionService` (queue + bus + tee + rehydrate), shared event mapper, new endpoints, registry changes. |
| `@shadow/web` | Session route segment, replay-then-follow ChatPage, retry button, session list UI. |
| `docs` | D6 amendment, API.md updates, this spec. |

---

## Tier 0 — one research agent per brief

Root cause (verified): one `WebResearchToolAgent` built in
`packages/api/src/composition.ts:74`, shared by every conversation; instance
`busy` flag throws `ResearchAgentBusyError` (`web-research-tool-agent.ts:156`);
tool handlers close over instance-level `this.active` (`:151`), so concurrent
runs on the shared instance would cross-contaminate findings even without the
flag.

**T0.1 — per-brief factory.** New `PerBriefResearchAgent` in
`@shadow/research`: implements `ResearchBriefPort.research(brief)` by
constructing a fresh `WebResearchToolAgent` (same deps) per call and
delegating. `WebResearchToolAgent` itself is untouched — its `busy`/`active`
state becomes single-run-scoped by construction. Wire it in `composition.ts`
(and `test-helpers.ts`). `ResearchAgentBusyError` stays defined but is no
longer reachable from the wiring; `error-mapping.ts`'s row for it stays until
Tier 0 is proven live, then is retired.
*Tests:* two `research()` calls in flight concurrently both complete (fake
transport with controlled latency); findings/sources do not bleed across runs;
evidence writes from both land (ULID source files, one ledger, append order
irrelevant).

**T0.2 — parallel briefs within a turn.** `conversation.ts`
`sendMessage`: emit `research-started` for every research directive up front;
run all briefs via `Promise`-per-brief pushing completion events into an async
queue the generator drains (a small `mergeAsyncEvents` utility in
`@shadow/agent`, unit-tested alone — this is the hardest code in the tier and
gets its own task on purpose). Completion events yield in settle order;
`followUps` are assembled in *directive order* after all settle, so the next
model turn is deterministic. Chapter directives stay strictly sequential,
after all research settles (they mutate the volume and audit serially by
design — unchanged).
*Tests:* controlled resolution order (brief 2 settles first) → events in
settle order, followUps in directive order; one brief failing doesn't sink the
others; budget/`maxAutoTurns` behavior unchanged.

**T0.3 — API/agent wiring test.** End-to-end handler test: two sessions
trigger research in overlapping turns; both streams complete; no
`research_agent_busy` SSE error.

**T0.4 — cost measurement (live smoke, gated like `live-smoke.test.ts`).**
Measure a second fresh research session's preamble cost (cache read vs write)
minutes after the first. Record the real per-brief cost in the D6 amendment
text (T2.6 carries the docs change). Not a blocker for shipping T0.1–T0.3.

Ships alone. No storage. Blast radius: `research`, `agent`, `api` wiring.

---

## Tier 1 — resilient turns

**T1.1 — derive “first turn” from the session id.**
`claude-agent-sdk-session.ts`: replace `turnsSent`-based `isFirstTurn`
(`:198`, incremented pre-flight at `:223`) with
`isFirstTurn = this.ownSessionId === undefined` — the id is only assigned on a
successful `result` (`:289`), so a failed first turn stays a first turn and a
retry re-honors the caller's original `options.resume`. The
`persistSession: false` guard keys off the same condition (a resumed-second
turn only exists once `ownSessionId` is set). `turnsSent` is deleted.
*Tests (fake `query`):* first turn fails mid-stream → second `stream()` call
passes the original `resume` options, not `resume: undefined`; first turn
succeeds → second call resumes own id; `persistSession: false` guard still
fires on a genuine second turn.

**T1.2 — `RetryPolicy` port.** `@shadow/model` `ports/retry-policy.ts`:

```ts
interface RetryPolicy {
  /** null = don't retry; number = delay ms before attempt `attempt + 1`. */
  delayBeforeRetry(failure: TurnFailure, attempt: number): number | null;
}
```

`TurnFailure` classifies both thrown errors and `isError` results, carrying
the raw message/stopReason. `conservativeRetryPolicy` (default): retries
529/“overloaded”, rate-limit, and transient 5xx signatures; 2 retries max at
~1s / ~4s; **never** retries “No conversation found” (that must fall through
immediately to Tier 2's fallback) and never auth/guardrail errors.
`noRetryPolicy` exported for tests/opt-out. Swap point: `createModel()`
options, surfaced through `composition.ts` — one line to change or disable.

**T1.3 — retrying session decorator.** `RetryingAgenticSession` wraps any
`AgenticSession`: `stream()` delegates and tracks whether *any event has been
yielded to the caller*; on failure with zero events yielded, consults the
policy and re-issues the turn; once a single delta/tool event has been
yielded, failures pass through untouched (no silent duplicate output — the
design's safety rule, enforced structurally at the only place that knows what
was yielded). Applied inside `createModel()` so both Shadow chat and research
agents get it without knowing.
*Tests:* fail-then-succeed fake → one seamless turn; fail-after-first-delta →
error surfaces, no retry; policy exhaustion → last error surfaces; retried
first turn preserves `resume` options (composes with T1.1).

**T1.4 — web retry affordance.** On a terminal `error` SSE event, ChatPage
keeps the failed operator text and shows **Retry last message**, which
re-sends it with the same `sessionId` (`chat-transcript.ts` gets an
`error`-item retry flag; `ChatPage.tsx` wires it). No server change — resend
is just another turn on the same session.
*Tests:* reducer marks retryable error items; fake-client script drives the
retry path.

Ships alone. Blast radius: `model`, `api` (wiring), `web`.

---

## Tier 2 — persist & resume, turns decoupled from requests

### Storage (`@shadow/sessions`, new package)

**T2.1 — store port + filesystem impl.**
`~/.shadow/sessions/<sessionId>/meta.json` + `events.jsonl` (append-only).

```ts
interface SessionMeta {
  id: string; volume: VolumeSlug; title: string | null;
  createdAt: string; lastActiveAt: string;
  sdkSessionId?: string;           // set once the first turn completes
}
interface StoredEventRecord {
  seq: number;                     // monotonic per session; SSE id on replay
  turnId: string; at: string;
  event: StoredSessionEvent;
}
interface SessionStore {
  create(meta): Promise<void>;
  get(id): Promise<SessionMeta | undefined>;
  list(filter?: { volume? }): Promise<SessionMeta[]>;   // newest first
  update(id, patch): Promise<void>;                     // title, lastActiveAt, sdkSessionId
  append(id, events): Promise<StoredEventRecord[]>;
  readEvents(id, fromSeq?): Promise<StoredEventRecord[]>;
  delete(id): Promise<void>;                            // directory only; SDK transcript is T2.6's job
}
```

`StoredSessionEvent` = the agent's `ShadowEvent` union **minus `text-delta`**
(the per-turn `assistant-message` already carries the full text; replay maps
it back to one `text` delta) **plus** two store-level records the agent layer
never emits: `operator-message` (the user bubble; appended by the service
before the turn runs) and `turn-boundary` (`started`/`ended`, with
`endReason: completed | error | interrupted`). Unknown event types on read are
preserved, not dropped (forward compat).
*Tests:* a `SessionStore` contract suite (mirroring the volume store's
pattern) run against `FileSystemSessionStore` and the in-memory fake;
corrupt/truncated last line of `events.jsonl` → readable prefix returned, not
a throw (crash-mid-append tolerance — mirrors `LedgerCorruptError`'s stance
but recovers, because a torn tail is an expected crash artifact here, not
hand-editing).

**T2.2 — shared event mapper.** Extract `handlers/chat.ts`'s
`ShadowEvent → wire SSE` mapping (the whole `switch`, brief-id minting
included) into `@shadow/api`'s `event-mapping.ts`, used by both the live path
and replay. Replay maps `assistant-message → text` (one delta) and
`operator-message → operator` (new wire event; the live path emits it too, so
live and replayed transcripts render identically and a second live viewer sees
user bubbles).
*Tests:* golden mapping tests; live vs replay of the same `ShadowEvent`
sequence produce identical wire sequences (delta coalescing aside).

### Agent (`@shadow/agent`)

**T2.3 — resume pass-through.** `StartConversationOptions` gains
`resume?: { sdkSessionId: string }`; `getOrCreateSession` forwards it as
`options.resume` (`@shadow/model` already supports it —
`agentic-session.ts:104`). With T1.1, a 529 on the resumed first turn retries
*with resume intact*; “No conversation found” is never retried and surfaces
for the fallback.
*Tests:* fake port asserts `resume` received; interplay with T1.1 covered in
model tests.

**T2.4 — dispose split.** `ShadowConversation.dispose()` (which deletes the
SDK transcript via `AgenticSession.close()`) is split:
`release()` — drop the handle, delete *nothing* (new eviction/shutdown path);
`deleteSdkTranscript()` — explicit deletion (only the DELETE endpoint calls
it). `ConversationRegistry` eviction and `start.ts` shutdown switch to
`release()`; the registry also refuses to evict a session with a running or
queued turn (skips to next-oldest).
*Tests:* eviction no longer deletes `~/.claude/projects/` entries (fake
`deleteSession` spy); busy sessions survive eviction pressure.

### API (`@shadow/api`)

**T2.5 — `SessionService`.** The new owner of session lifecycle, replacing
direct registry access in handlers. Holds: `SessionStore`, the LRU registry
(demoted to a cache of live handles), per-session FIFO turn queue, per-session
in-memory event bus.

- `enqueueTurn(sessionId | {volume}, message)` → creates the session row on
  first turn; appends `operator-message` + `turn-boundary(started)`; runs
  turns strictly FIFO per session. The turn drains
  `conversation.sendMessage()`, tees every stored-shape event to
  `store.append` and to the bus, and appends `turn-boundary(ended)` in a
  `finally`. **The turn does not stop when viewers detach** — the SSE
  response's `cancel()` now unsubscribes that viewer from the bus instead of
  `iterator.return()`. Queue full (4) → `409 turn_queue_busy`.
- `rehydrate(sessionId)` on registry miss: `store.get` → miss in both = 404
  `session_not_found`; hit = `startConversation(volume, { conversationId,
  resume: { sdkSessionId } })` (T2.3).
- **Fallback**: if the resumed first turn fails with the SDK's
  “No conversation found” (or the transcript is otherwise unusable), rebuild
  the conversation *without* `resume` and prepend a transcript summary to
  that turn's prompt. Summary spec (deterministic, no LLM call): last 12
  `operator-message`/`assistant-message` texts, each clipped to 500 chars,
  under a fixed header — cheap, predictable, testable. `meta.sdkSessionId` is
  overwritten by the new session's id on success.
- On first-turn completion, write `sdkSessionId` to meta; bump
  `lastActiveAt` per turn.

*Tests:* tee (store receives everything but deltas, plus operator/boundary
records); FIFO ordering with 2 queued turns (events interleave never);
viewer-detach mid-turn → turn completes and store is whole; rehydrate happy
path; fallback path (fake session whose resumed turn fails with
no-conversation-found → second construction without resume, summary present
in prompt, no auto-retry in between); 404 only when absent from both.

**T2.6 — decision-log + docs.** Amend `DECISIONS.md`: D6b — persistence
inverts D6a's cleanup: SDK transcripts outlive the process; eviction/shutdown
release only; the sole deletion path is the explicit session delete (store
directory + SDK transcript together, no orphans). Include T0.4's measured
per-brief cost. Update `docs/API.md` chat/session sections to the wire
reality (it is currently flagged as diverging).

**T2.7 — replay + follow endpoint.** `GET /api/sessions/:id/events`
(SSE): replays stored events through the shared mapper with `id: <seq>`;
with `?follow=true`, after replay it subscribes to the bus and keeps
streaming until the session is idle (then `done`). Supports `Last-Event-ID`/
`?fromSeq=` so a dropped follow reconnects without re-replaying. Registry
miss does **not** rehydrate here — replay is read-only; rehydration happens
on the next turn.
*Tests:* replay-only, replay-then-follow during a running turn (storeed
prefix + live tail, no gap/duplicate around the seq boundary), reconnect with
fromSeq.

### Web (`@shadow/web`)

**T2.8 — URL identity + replay.** Route `#/v/:slug/chat/:sessionId`
(`useHashRoute.ts`; `#/v/:slug/chat` stays “new chat” and navigates to the id
from the `session` event on first send). On mount with a session id: open
replay+follow, feed events through `applyStreamEvent`; sends go through
`POST /api/chat` as today. Reducer additions: `operator` wire event;
tolerate a transcript that ends mid-turn (missing `turn-ended` → render an
“interrupted” marker, offer Retry). `http-client.ts`/`fake-client.ts`/
`contract.test.ts` extended for the new endpoint.
*Tests:* parseHash round-trip; reducer replay = live-driven transcript for
the same script; truncated-turn rendering.

Ships as one tier; T2.1/T2.2 land first (pure, no behavior change), then
T2.3/T2.4, then T2.5/T2.7, then T2.8, docs alongside.

---

## Tier 3 — session management

**T3.1 — endpoints.** `GET /api/sessions?volume=` (newest-first; omitting
`volume` = global list — shape decided now, so it's a no-cost extension),
`PATCH /api/sessions/:id { title }`, `DELETE /api/sessions/:id` (store
directory + registry entry + SDK transcript via `deleteSdkTranscript()`; 409
if a turn is running or queued). Title defaults to the first
`operator-message`'s first line (clipped ~60 chars) at first-turn time, stored
in meta — `PATCH` overrides.
*Tests:* handler suite incl. delete-while-busy 409 and no-orphan assertion
(store dir gone + `deleteSession` called).

**T3.2 — UI.** Session list on the chat screen (per current volume):
title, last-active, resume (navigates to the session URL), rename inline,
delete with confirm. Driven by the same `ApiClient` abstraction; fake-client
scripts for tests.

---

## Failure behavior (superset of the design's table)

| Failure | Behavior |
|---|---|
| Transient error, no output yet | Auto-retry per policy; then error item + Retry button. |
| Transient error, partial output | Error + Retry immediately — no silent duplicate. |
| Failed first turn | Stays a first turn (T1.1); original `resume` re-honored on retry. |
| Reload / restart / eviction | Replay from store; next turn rehydrates via SDK resume. |
| **Reload mid-turn** | Turn keeps running server-side; replay + follow catches the viewer up live. |
| **Second message while a turn runs** | FIFO-queued (per-session queue); >4 pending → 409. |
| **Server crash mid-turn** | Torn tail tolerated on read; transcript shows interrupted turn; next turn resumes the SDK session at its last completed turn. |
| SDK resume fails | Fresh session + deterministic transcript summary in prompt; replay unaffected; not auto-retried. |
| Unknown session id | 404 `session_not_found` — only when absent from registry *and* store. |
| Research busy | Eliminated (Tier 0). |
| **Delete while turn running** | 409; delete after it settles. |

## Sequencing & test spine

Tiers ship independently in order 0 → 1 → 2 → 3; within Tier 2 the order
above. Every task lands TDD: contract suite for `SessionStore`; fake-`query`
adapter tests for T1.1/T1.3; merge-utility tests for T0.2; service tests for
queue/tee/rehydrate/fallback; golden mapper tests shared by live/replay;
reducer replay tests. `FakeAgenticSessionPort` grows transient-failure and
no-conversation-found scripting (the D6a rule: a fake must reproduce the real
failure modes) — that's a prerequisite for T1.3 and T2.5 tests, done as part
of T1.2.
