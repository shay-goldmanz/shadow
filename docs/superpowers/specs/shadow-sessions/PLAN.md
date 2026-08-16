# Shadow Sessions — Implementation Plan

Status: **reviewed** (adversarial model review incorporated — see changelog at
bottom). Implements the locked design (“Shadow Sessions”, 4 tiers) with the
refinements agreed in review. Companion to `docs/DECISIONS.md` (amends D6a —
see T2.6).

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
   - *Across sessions*: parallel by default once the shared mutable state is
     gone. Tier 0 removes **all three** shared hot spots, not just the one the
     locked design names: the shared research agent (T0.1), the shared
     `AgenticSearchProvider` session underneath it (T0.5), and same-volume
     chapter publication (T0.6 — a pre-existing race that session listing
     makes much easier to hit).
   - *Within a session*: turns are FIFO-serialized by a per-session queue.
     Two tabs on one session both work — the second `POST /api/chat` enqueues
     rather than racing (`turnsSent`, duplicate `resume` subprocesses) or
     being rejected. The queue — together with single-flighted rehydration
     (T2.5) — is the *only* same-session write path, which is also what makes
     the SDK safe: two concurrent `query()` calls resuming the same SDK
     session id would append to one transcript from two subprocesses; the
     lock makes that unrepresentable. Queue bound: 4 pending; beyond that
     `409 turn_queue_busy`. (Today's UI disables input while its own turn
     streams, so queued turns only arise from multiple tabs — fine.)
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
| `@shadow/model` | First-turn fix in `ClaudeAgentSdkSession`; `RetryPolicy` port + retrying decorator; id-based transcript deletion; fakes that can fail transiently. |
| `@shadow/research` | Per-brief agent factory (`ResearchBriefPort` impl); non-persisted research sessions; search-provider concurrency fix. |
| `@shadow/agent` | Parallel research directives; per-volume publish lock; `resume` pass-through + in-conversation resume fallback; dispose split. |
| `@shadow/api` | `SessionService` (queue + bus + tee + single-flight rehydrate), shared event mapper, new endpoints, registry changes, shutdown handling. |
| `@shadow/web` | Session route segment, replay-then-follow ChatPage, operator-event-driven user bubbles, retry button, session list UI. |
| `docs` | D6 amendment, API.md updates, this spec. |

---

## Tier 0 — concurrency: remove every shared hot spot

Root cause (verified): one `WebResearchToolAgent` built in
`packages/api/src/composition.ts:74`, shared by every conversation; instance
`busy` flag throws `ResearchAgentBusyError` (`web-research-tool-agent.ts:156`);
tool handlers close over instance-level `this.active` (`:151`), so concurrent
runs on the shared instance would cross-contaminate findings even without the
flag. Review found two further shared-state hazards this tier must also close
(T0.5, T0.6) — without them, “sessions share no mutable state” would be false.

**T0.1 — per-brief factory, non-persisted sessions.** New
`PerBriefResearchAgent` in `@shadow/research`: implements
`ResearchBriefPort.research(brief)` by constructing a fresh
`WebResearchToolAgent` (same deps) per call and delegating. A per-brief agent
receives exactly one `research()` call — one `stream()`, one turn — so the
cross-call `resume` rationale for persistence vanishes: the factory sets
`persistSession: false` (threaded through `sessionTuning`, a small addition to
`web-research-tool-agent.ts`). This also prevents the leak the shared design
would otherwise create: one orphaned `~/.claude/projects/` transcript per
brief, forever (nothing ever closed the research session even today).
`ResearchAgentBusyError` stays defined but is no longer reachable from the
wiring; `error-mapping.ts`'s row for it stays until Tier 0 is proven live,
then is retired. Wire in `composition.ts` and `test-helpers.ts`.
*Tests:* two `research()` calls in flight concurrently both complete (fake
transport with controlled latency); findings/sources do not bleed across runs;
evidence writes from both land (verified safe: `appendLedgerEvent` is a single
O_APPEND `appendFile`, `evidence/store.ts:333-346`; snapshots are
content-addressed; source files ULID-named); created sessions are
non-persisted (fake port asserts the option).

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
text (T2.6 carries the docs change). Also informs T0.5's choice below. Not a
blocker for shipping T0.1–T0.3.

**T0.5 — search-provider concurrency.** `AgenticSearchProvider`
(`composition.ts:72-73`) lazily creates **one** `AgenticSession` reused by
every `search()` call, with no busy guard — under T0.2's parallel briefs (and
cross-session parallelism generally), concurrent `search()` calls would run
concurrent `query()` subprocesses resuming the same SDK session id: exactly
the duplicate-resume race this plan makes unrepresentable for chat. Fix:
per-call one-shot sessions (`persistSession: false` — each `search()` is a
single turn, so nothing needs resume), keeping the provider stateless. If
T0.4's measurement shows per-call preamble cost is prohibitive, the recorded
fallback is an internal FIFO queue on the provider instead — but the default
is the simple, stateless fix.
*Tests:* fake session port asserts one session per `search()` call and
non-persistence; concurrent `search()` calls don't share a session. (Note:
`ReplayTransport`-based research tests never touch the provider, which is why
nothing caught this — the test must target `AgenticSearchProvider` directly.)

**T0.6 — per-volume publication lock.** Chapter publication does
read-modify-write on shared per-volume files (sidecar read→write plus
retirement appends, `evidence/store.ts:258-290`) and reindexes; directives are
serialized only *within* one conversation (`conversation.ts:285-289`). Two
sessions on the same volume can already race this today; the session-list UI
makes it easy. Add a per-volume async mutex owned by `ShadowAgent` (shared
across the conversations it mints), held around draft+publish of each chapter
directive.
*Tests:* two conversations on one volume submit chapter directives
concurrently → publications strictly serialized (interleaving-order probe via
instrumented fake store).

Ships alone. No storage. Blast radius: `research`, `agent`, `api` wiring.

---

## Tier 1 — resilient turns

**T1.1 — derive “first turn” from a *successful* session id.**
`claude-agent-sdk-session.ts`: today `turnsSent`-based `isFirstTurn` (`:198`,
incremented pre-flight at `:223`) makes a failed first turn look like a
follow-up (`resume: undefined`, original `options.resume` dropped). The naïve
fix — `isFirstTurn = ownSessionId === undefined` — is **not enough**, because
`case "result"` assigns `ownSessionId` unconditionally (`:289`), *including
error results* (`is_error: true` — the common shape for 529/overloaded).
The fix is therefore two-part: (a) assign `ownSessionId` only when the result
is not an error; (b) when an error result *does* carry a `session_id`,
remember it in a `failedSessionIds` set so `close()` (`:325-335`, currently
keyed off `ownSessionId` alone) can delete any transcript a persisted-but-
errored turn may have written — no undeletable orphans. `turnsSent` is
deleted; the `persistSession: false` guard keys off `ownSessionId` (a
resumed-second turn only exists once a turn has *succeeded*).
`FakeAgenticSession` mirrors all of it: no id assignment on `isError` scripts,
same first-turn derivation, deletable failed ids (D6a's rule — the fake must
reproduce the real failure modes).
*Tests (fake `query`):* first turn fails via thrown error → second `stream()`
passes the original `resume` options; first turn fails via `isError` *result*
→ same (id not latched); success → second call resumes own id;
`persistSession: false` guard still fires on a genuine second turn; `close()`
after an errored persisted first turn deletes the failed transcript.

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
This task also grows `FakeAgenticSessionPort` transient-failure and
no-conversation-found scripting — prerequisite for T1.3 and T2.5 tests.

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
  seq: number;                     // monotonic per session; replay cursor
  turnId: string; at: string;
  event: StoredSessionEvent;
}
interface SessionStore {
  create(meta): Promise<void>;
  get(id): Promise<SessionMeta | undefined>;
  list(filter?: { volume? }): Promise<SessionMeta[]>;   // newest first
  update(id, patch): Promise<void>;                     // title, lastActiveAt, sdkSessionId
  append(id, events): Promise<StoredEventRecord[]>;     // returns seq-stamped records
  readEvents(id, fromSeq?): Promise<StoredEventRecord[]>;
  delete(id): Promise<void>;                            // directory only; SDK transcript deletion is T2.4/T3.1's job
}
```

`StoredSessionEvent` = the agent's `ShadowEvent` union **minus `text-delta`**
(the per-turn `assistant-message` already carries the full text; replay maps
it back to one `text` delta), **with research events augmented with a
`briefId`** (assigned at tee time — see T2.2; correlation by object identity
does not survive a JSON round-trip, so it must be stored, not re-derived),
**plus** store-level records the agent layer never emits:

- `operator-message` — the user bubble; appended when the turn *starts
  running* (not at enqueue — a queued turn must not interleave its records
  into the running turn's seq range, and a crash while queued should lose the
  queued message cleanly rather than read as an interrupted turn);
- `turn-boundary` — `started` (at run start) / `ended` with
  `endReason: completed | error | interrupted` **and, for `error`, the
  message/code** — thrown errors (`AutoTurnBudgetExceededError`, handler-level
  catches) are not `ShadowEvent`s, so the boundary record is where their
  content survives for replay. (Agent-emitted `{ type: "error" }` events are
  ordinary stored events already covered by the union.)

Unknown event types on read are preserved, not dropped (forward compat).
*Tests:* a `SessionStore` contract suite (mirroring the volume store's
pattern) run against `FileSystemSessionStore` and the in-memory fake;
corrupt/truncated last line of `events.jsonl` → readable prefix returned, not
a throw (crash-mid-append tolerance — mirrors `LedgerCorruptError`'s stance
but recovers, because a torn tail is an expected crash artifact here, not
hand-editing).

**T2.2 — shared event mapper.** Extract `handlers/chat.ts`'s
`ShadowEvent → wire SSE` mapping into `@shadow/api`'s `event-mapping.ts`, used
by both the live path and replay — with brief-id handling moved *out* of the
per-request `WeakMap` (`chat.ts:152-153`): the tee assigns
`briefId = "<turnId>/brief-<n>"` when it stores `research-started`
(correlating completed/failed by object identity *at tee time*, where it still
works), and the mapper reads the stored id on both paths. Replay maps
`assistant-message → text` (one delta) and `operator-message → operator` (new
wire event; the live path emits it too, so live and replayed transcripts
render identically and a second live viewer sees user bubbles). Note: this
makes T2.2 a (compatible) wire-contract change, not a pure refactor — today's
reducer tolerates unknown events by design (`chat-transcript.ts`'s exhaustive
switch with a defensive default), and T2.8 makes the reducer consume it
properly.
*Tests:* golden mapping tests; live vs replay of the same stored sequence
produce identical wire sequences; briefIds stable across replay and unique
across turns.

### Agent (`@shadow/agent`)

**T2.3 — resume pass-through + in-conversation fallback.**
`StartConversationOptions` gains
`resume?: { sdkSessionId: string; fallbackSummary?: string }`;
`getOrCreateSession` forwards `resume` as `options.resume` (`@shadow/model`
already supports it — `agentic-session.ts:104`). With T1.1/T1.2, a 529 on the
resumed first turn retries *with resume intact*; “No conversation found” is
never retried.

The **fallback lives here, inside `ShadowConversation`**, not in the API
service — for two reasons found in review: (a) `sendMessage` records the
operator turn as a citable transcript source *before* the model turn runs
(`conversation.ts:238-246`); a service-level “re-send with summary prepended”
would record the operator turn twice **and** smuggle the summary into
quotable operator speech (D19/D23 violation — fabricated operator text).
Instead: when the resumed *first* turn fails with the SDK's
no-conversation-found error, the conversation drops its dead session handle,
recreates the session *without* `resume`, and re-issues the same turn with
`fallbackSummary` prepended to the **model prompt only** — clearly framed as
prior-conversation context (“Context recovered from a previous conversation —
not operator speech; never cite it as an operator source”), never passed to
`recordSessionTranscriptSource`, which has already run exactly once.
*Tests:* fake port asserts `resume` received; resumed-first-turn
no-conversation-found → second session created without resume, summary in
prompt, operator source recorded once, summary text absent from the recorded
source.

**T2.4 — dispose split + id-based SDK deletion.**
`ShadowConversation.dispose()` (which deletes the SDK transcript via
`AgenticSession.close()`) is replaced by `release()` — drop the handle, delete
*nothing*. `ConversationRegistry` eviction and `start.ts` shutdown switch to
it; the registry also refuses to evict a session with a running or queued turn
(skips to next-oldest). Two consequences the plan makes explicit:
- the registry invariant weakens from `size ≤ maxSize` to
  `size ≤ maxSize + busy-count` — the eviction loop must terminate by
  tolerating that overshoot, and the `SessionService` re-runs eviction when a
  turn settles so skipped sessions don't linger;
- **deletion cannot go through the live handle at all**: a cold session
  (stored, not in the registry — e.g. post-restart) has no `AgenticSession`,
  and `close()` is keyed off in-memory state (`conversation.ts:227-229`,
  `claude-agent-sdk-session.ts:326`), so handle-based deletion would orphan
  `~/.claude/projects/<sdkSessionId>` forever. `@shadow/model` therefore
  exposes id-based deletion — `deleteStoredSession(sdkSessionId)` on the
  session port (wrapping the SDK's `deleteSession`, already imported at
  `claude-agent-sdk-session.ts:28`; mirrored in the fake) — and the DELETE
  endpoint (T3.1) drives it from `meta.sdkSessionId`, never from the handle.
*Tests:* eviction no longer deletes `~/.claude/projects/` entries (fake
`deleteSession` spy); busy sessions survive eviction pressure and are evicted
after settling; cold-session delete removes the SDK transcript via the port.

### API (`@shadow/api`)

**T2.5 — `SessionService`.** The new owner of session lifecycle, replacing
direct registry access in handlers. Holds: `SessionStore`, the LRU registry
(demoted to a cache of live handles), a **per-session-id async lock** that
serializes *everything* stateful — rehydration and turns alike — plus a
per-session in-memory event bus.

- `enqueueTurn(sessionId | {volume}, message)` → creates the session row on
  first turn; turns run strictly FIFO per session. At run start the service
  appends `operator-message` + `turn-boundary(started)`, drains
  `conversation.sendMessage()`, tees every stored-shape event to
  `store.append`, publishes the **seq-stamped `StoredEventRecord`s the append
  returns** to the bus (post-append, so bus consumers can dedupe by `seq` —
  see T2.7), and appends `turn-boundary(ended, …)` in a `finally` (carrying
  message/code for thrown errors, per T2.1). **The turn does not stop when
  viewers detach** — the SSE response's `cancel()` now unsubscribes that
  viewer from the bus instead of `iterator.return()`. Queue full (4) →
  `409 turn_queue_busy`.
- `rehydrate(sessionId)` on registry miss runs **inside the same per-session
  lock** as turns — review flagged that two concurrent POSTs to a cold
  session would otherwise both construct resuming conversations, exactly the
  duplicate-resume race the queue exists to prevent. Single-flighted: one
  caller rehydrates, both turns queue behind it. Miss in registry *and* store
  = 404 `session_not_found`. On rehydrate, the service reads stored events to
  build the `fallbackSummary` (deterministic, no LLM call: last 12
  `operator-message`/`assistant-message` texts, each clipped to 500 chars,
  under a fixed header) and passes it with `resume` to `startConversation`
  (T2.3 owns *using* it).
- On first-turn completion, write `sdkSessionId` to meta (also after a
  successful fallback rebuild — the new session's id overwrites the dead
  one); bump `lastActiveAt` per turn.

*Tests:* tee (store receives everything but deltas, plus operator/boundary
records, in the running turn's seq range only); FIFO ordering with 2 queued
turns; viewer-detach mid-turn → turn completes and store is whole;
single-flight rehydrate (two concurrent cold POSTs → one construction);
fallback plumbing; 404 only when absent from both; eviction re-run on settle.

**T2.6 — decision-log + docs.** Amend `DECISIONS.md`: D6b — persistence
inverts D6a's cleanup: SDK transcripts outlive the process; eviction/shutdown
release only; the sole deletion path is the explicit session delete (store
directory + SDK transcript together, no orphans — including cold sessions,
via T2.4's id-based deletion). Include T0.4's measured per-brief cost. Update
`docs/API.md` chat/session sections to the wire reality (it is currently
flagged as diverging).

**T2.7 — replay + follow endpoint.** `GET /api/sessions/:id/events`
(SSE): with `?follow=true`, the handler **subscribes to the bus first,
buffers**, then replays stored events (each carrying its `seq`), then drains
the buffer deduplicated by `seq` — closing the replay-end/subscribe gap
review flagged. The stream then stays open across idle (the existing
keepalive heartbeat pattern covers proxies): “turn ended” is *not* a close
condition, otherwise a passive second tab goes blind after every turn; it
closes only on client disconnect or session deletion. Reconnect cursor is
`?fromSeq=` — the web client's SSE reader is fetch-based and ignores `id:`
lines (`web/src/api/sse.ts`), so `Last-Event-ID` plumbing is explicitly *not*
built; `fromSeq` is the one mechanism. Registry miss does **not** rehydrate
here — replay is read-only; rehydration happens on the next turn.
*Tests:* replay-only; replay-then-follow during a running turn (stored prefix
+ live tail, no gap/duplicate around the seq boundary — bus-first-buffer
makes this deterministic); reconnect with fromSeq; follow survives an idle
gap between turns and streams the next turn.

**T2.8 — web: URL identity + replay.** Route `#/v/:slug/chat/:sessionId`
(`useHashRoute.ts`; `#/v/:slug/chat` stays “new chat” and navigates to the id
from the `session` event on first send). On mount with a session id: open
replay+follow, feed events through `applyStreamEvent`; sends go through
`POST /api/chat` as today. Reducer changes: consume the `operator` wire event
as the **single source of user bubbles** — `ChatPage.tsx` drops its local
`appendUserMessage` (`ChatPage.tsx:33`), otherwise the sending tab renders
every user message twice; tolerate a transcript that ends mid-turn (missing
`turn-ended` → “interrupted” marker + Retry). Input stays disabled while this
tab's own turn streams (unchanged — queued turns come from other tabs).
`http-client.ts`/`fake-client.ts`/`contract.test.ts` extended for the new
endpoint.
*Tests:* parseHash round-trip; reducer replay = live-driven transcript for
the same script; exactly one user bubble per send; truncated-turn rendering.

**T2.9 — graceful shutdown with in-flight turns.** Once turns outlive
requests, `start.ts`'s SIGINT path (`disposeAll()` → `server.stop()` →
`process.exit(0)`) would hard-kill SDK subprocesses mid-turn and tear
`store.append` mid-write — turning *every* Ctrl-C-during-a-turn into the
crash path. New sequence: stop accepting turns (`503` on enqueue), signal
running turns to wind down (`iterator.return()` — the generator's `finally`
blocks and the service's `finally` still run), append
`turn-boundary(ended, interrupted)` for each, flush appends, release handles,
exit; bounded by a ~10s deadline after which it exits anyway (the torn-tail
read tolerance from T2.1 is the backstop, not the norm).
*Tests:* fake-clock service test — shutdown during a running turn writes the
interrupted boundary and completes within the deadline.

Ships as one tier; order within: T2.1/T2.2 first (T2.1 pure; T2.2 a
compatible wire addition), then T2.3/T2.4, then T2.5/T2.7/T2.9, then T2.8,
docs alongside.

---

## Tier 3 — session management

**T3.1 — endpoints.** `GET /api/sessions?volume=` (newest-first; omitting
`volume` = global list — shape decided now, so it's a no-cost extension),
`PATCH /api/sessions/:id { title }`, `DELETE /api/sessions/:id` (store
directory + registry entry + SDK transcript via the model port's id-based
`deleteStoredSession(meta.sdkSessionId)` — works for cold sessions too; 409
if a turn is running or queued). Title defaults to the first
`operator-message`'s first line (clipped ~60 chars) at first-turn time, stored
in meta — `PATCH` overrides. New `error-mapping.ts` rows: `turn_queue_busy`
(409), `session_busy` (409, delete-while-busy), `session_not_found` (404),
shutdown 503.
*Tests:* handler suite incl. delete-while-busy 409, cold-session delete, and
no-orphan assertion (store dir gone + port-level `deleteStoredSession`
called).

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
| Failed first turn (throw *or* error result) | Stays a first turn (T1.1); original `resume` re-honored on retry; failed persisted transcripts tracked for cleanup. |
| Reload / restart / eviction | Replay from store; next turn rehydrates via SDK resume. |
| Reload mid-turn | Turn keeps running server-side; replay + follow catches the viewer up live (seq-deduped, no gap). |
| Second message while a turn runs | FIFO-queued (per-session lock); >4 pending → 409 `turn_queue_busy`. |
| Concurrent first messages to a cold session | Single-flighted rehydration; one resume, both turns queue. |
| Server crash mid-turn | Torn tail tolerated on read; transcript shows interrupted turn; next turn resumes the SDK session at its last completed turn. |
| Server crash with a turn *queued* | Queued message lost cleanly (nothing appended until run start) — no phantom interrupted turn. |
| SIGINT with a turn running | Graceful wind-down: interrupted boundary written, appends flushed, bounded by deadline (T2.9). |
| SDK resume fails | In-conversation fallback: fresh session + deterministic summary in the model prompt only (never citable as operator speech); replay unaffected; not auto-retried. |
| Unknown session id | 404 `session_not_found` — only when absent from registry *and* store. |
| Research busy | Eliminated (Tier 0) — including the shared search-provider session (T0.5). |
| Same-volume chapter race (two sessions) | Serialized by per-volume publish lock (T0.6). |
| Delete while turn running/queued | 409; delete after it settles. Cold-session delete still removes the SDK transcript (id-based). |

## Sequencing & test spine

Tiers ship independently in order 0 → 1 → 2 → 3; within Tier 2 the order
above. Every task lands TDD: contract suite for `SessionStore`; fake-`query`
adapter tests for T1.1/T1.3; merge-utility tests for T0.2; service tests for
lock/queue/tee/rehydrate/fallback/shutdown; golden mapper tests shared by
live/replay; reducer replay tests. `FakeAgenticSessionPort` grows
transient-failure, error-result, and no-conversation-found scripting plus
id-based deletion (the D6a rule: a fake must reproduce the real failure
modes) — done in T1.1/T1.2 as prerequisites.

---

## Review changelog

Adversarial model review (Fable) of the first draft surfaced, and this
revision incorporates: first-turn derivation must exclude error-result
session ids and track failed transcripts for cleanup (T1.1); the shared
`AgenticSearchProvider` session was an unhandled duplicate-resume race
(T0.5); same-volume chapter publication races across sessions (T0.6);
per-brief research sessions should be non-persisted or they leak one SDK
transcript per brief (T0.1); briefId correlation must be stored, not
re-derived via object identity (T2.1/T2.2); cold-session delete needs
id-based SDK transcript deletion at the port (T2.4/T3.1); rehydration must be
single-flighted under the per-session lock (T2.5); the resume fallback must
live inside the conversation to avoid double-recording the operator source
and fabricating citable operator speech (T2.3); bus-first-buffer-then-replay
with seq dedupe (T2.7); follow must survive idle (T2.7); graceful shutdown
with decoupled turns needs its own task (T2.9); operator/boundary records
written at run start, error content carried on boundaries (T2.1); the live
`operator` wire event replaces the client's local user-bubble append (T2.8);
LRU busy-skip weakens the size invariant and needs re-eviction on settle
(T2.4); `fromSeq` is the sole reconnect cursor — no `Last-Event-ID` plumbing
(T2.7); new 409/503 error-mapping rows (T3.1).
