# API contract

The transport between `@shadow/web` (the operator's interface) and everything beneath it.
`@shadow/api` implements this; `@shadow/web` consumes it. Both are built against this
document rather than against each other.

**The API is a transport adapter, not a place where behaviour lives.** It holds no domain
logic. Every endpoint is a thin call into `@shadow/agent`, `@shadow/core`, `@shadow/indexing`,
or `@shadow/evidence`. If something needs deciding, it gets decided in a pillar, not here.

Served by `Bun.serve` on **`127.0.0.1`** — explicit IPv4 loopback, not the string `localhost`,
which Bun binds to IPv6 only on macOS and which then refuses an IPv4 client. JSON in, JSON out,
except the chat stream.

**This contract is enforced, not just described.** `packages/web/src/api/contract.test.ts`
drives the real `HttpApiClient` against a real `createServer` with offline fakes. It exists
because the interface was originally built against a *guessed* wire format that its own fake
then confirmed — every web test passed while every screen but one crashed against the real API.
A doc cannot prevent that; a test can.

Two shapes worth stating plainly, since both caused crashes:
- `GET /api/volumes` returns full `Volume` objects. **There is no `chapterCount` field**, here
  or anywhere.
- `GET .../chapters/:chapter` returns `claims` as a whole **`ClaimSidecar`** (the array is
  `claims.claims`), not a bare `Claim[]`.
- `GET .../index` returns the raw `VolumeIndexDocument` **unwrapped**; `POST /reindex` wraps
  the same document as `{ index, stats }`. The asymmetry is real — do not assume one from the
  other.

## Volumes

```
GET    /api/volumes                       → { volumes: VolumeSummary[] }
POST   /api/volumes                       { slug?, title, description? } → { volume }
GET    /api/volumes/:slug                 → { volume, chapters: ChapterSummary[] }
PATCH  /api/volumes/:slug                 { title?, description?, frontmatter? } → { volume }
DELETE /api/volumes/:slug                 → { deleted: true }
```

`slug` is derived from `title` when omitted. Slug validation errors surface as `400`, not `500`
— they are user input, and `@shadow/core` already types them.

## Chapters

```
GET    /api/volumes/:slug/chapters/:chapter   → { chapter, claims?, audit? }
PUT    /api/volumes/:slug/chapters/:chapter   { title, body, frontmatter? } → { chapter, audit }
DELETE /api/volumes/:slug/chapters/:chapter   → { deleted: true }
```

A chapter write triggers a re-audit and a reindex. **The response carries the audit result**,
because a failing chapter is not publishable (D9) and the operator must see why immediately.

## Index

```
GET    /api/volumes/:slug/index           → the volume's index tree
POST   /api/volumes/:slug/reindex         → { index, stats }
GET    /api/lint?volume=:slug             → LintReport   (D14; may be slow, model-backed)
```

## Evidence

```
GET    /api/volumes/:slug/evidence/sources/:id   → SourceRecord
GET    /api/volumes/:slug/evidence/snapshot/:hash → text/plain, the pinned snapshot
GET    /api/volumes/:slug/evidence/ledger         → { events }   (append-only, newest last)
```

The snapshot endpoint is what makes a citation *inspectable*: the operator can read the exact
bytes a claim was written from. That is the chain of evidence made visible rather than merely
recorded.

## Chat — Server-Sent Events

```
POST   /api/chat            { volumeSlug?, message, sessionId? }  → text/event-stream
```

Pass `sessionId` to continue an existing conversation, or `volumeSlug` to start a new one (one of
the two is required; `volumeSlug` is ignored once `sessionId` is present). `message` must be a
non-empty string. Failures in resolving the request itself — bad shape, an unknown `volumeSlug`,
an unknown `sessionId`, or that session's turn queue already being full — are ordinary JSON error
responses **before** the stream opens (see Errors below); only a failure *during* the turn becomes
an in-band `error` SSE event.

Turns are enqueued on the session, not owned by this request: **the turn keeps running
server-side even if this client disconnects** (nav away, tab close, reload). A dropped connection
only unsubscribes that one viewer — it does not cancel the turn, and does not lose any of its
output. Reconnect via `GET /api/sessions/:id/events?follow=true` (below) to pick the same turn
back up, live tail included.

Shadow's turns stream as SSE. Event names mirror what the operator needs to *see happening*,
since research is slow and silence reads as failure:

| event | data | meaning |
|---|---|---|
| `session` | `{ sessionId }` | first event; echo it back to continue the conversation (D6) |
| `operator` | `{ text }` | the user's own message, echoed back as a stored record — the **one** source of the user bubble; a client that also renders its own locally-typed message before this arrives will double it |
| `text` | `{ delta }` | assistant prose, incremental |
| `research.started` | `{ briefId, brief }` | `brief` is a `ResearchBrief` **object** (`volume`, `goal`, optional `subjectDomains`/`constraints`/`maxSources`) |
| `research.source` | `{ sourceId, url, title }` | a source was retrieved and snapshotted |
| `research.finished` | `{ briefId, findings }` | `findings` is `Finding[]` — `{ text, citations: [{ sourceId, quote }] }` |
| `research.failed` | `{ briefId, brief, error }` | a brief could not be fulfilled |
| `chapter.drafted` | `{ volume, chapter }` | a chapter was written |
| `audit` | `{ volume, chapter, passed, repairs }` | audit result — **may be a failure** |
| `chapter.restated` | `{ claim, from, to, reason, outcome }` | conservative repair, or an escalation |
| `chapter.published` | `{ volume, chapter }` | passed the audit and was written |
| `chapter.rejected` | `{ volume, chapter, issues }` | failed the audit; **not** an error |
| `error` | `{ message, code }` | terminal for this turn |
| `done` | `{}` | turn complete |

`briefId` correlates a brief's `started`/`source`/`finished`/`failed` events across the turn —
stable within one turn, unique across turns.

**`turn.interrupted` (graceful-shutdown marker) does not appear on this stream.** A turn that is
still running when the server begins a graceful shutdown ends with a stored
`turn-boundary(ended, interrupted)` record rather than `completed` — but this endpoint's live
mapping has no wire case for it, so a `POST /api/chat` viewer watching when that happens simply
sees `done`, indistinguishable on the wire from an ordinary successful turn. `GET
/api/sessions/:id/events` is the one place `turn.interrupted` is actually observable (below) —
reconnect there to see it and offer Retry.

**Heartbeats.** An SSE comment line (`: keepalive`) is sent every 5 seconds while the stream is
open, so a proxy or client idle timeout never severs a connection mid-turn just because Shadow
has been silently thinking (a research brief fetching several pages, an audit pass) — invisible
to `EventSource` and to `web/src/api/sse.ts`'s own parser.

**`sessionId` is this session's own id**, minted when the conversation is created and stable for
its whole life — not the underlying `AgenticSession`'s own id (`meta.sdkSessionId`), which is
minted only once the first turn actually completes and is never sent to the client. The client
only ever sees and echoes the former.

**There is no `indexed` event on this stream.** Reindexing happens as part of publication, but
the repair result carries no index stats, and re-running the indexer purely to report them
would index twice. Stats come from `POST /reindex`.

**The `audit` shape differs by endpoint**, deliberately — each carries what its caller needs:

| where | shape |
|---|---|
| chat SSE `audit` | `{ volume, chapter, passed, repairs }` |
| `GET .../chapters/:chapter` | `AuditRecord` — `{ chapter, auditedAt, verdict: { chapter, passed, outcomes }, routingMetadataHash? }` |
| `PUT .../chapters/:chapter` | `{ verdict, outcomes, repairs, published }` |

In all three, **pass/fail is a boolean nested under a verdict object** — never a bare `"pass"`
string. A client that tests for one is reading a shape that has never existed, which is
precisely how the interface came to render "Audit failed" for every audit including passing
ones.

`sessionId` must be echoed by the client on the next message. Without it every turn pays the
~18k-token preamble (D6).

`chapter.restated` is deliberately visible in the stream: D9 requires that what Shadow softened
and why stays in front of the operator rather than being quietly cleaned up.

## Session events — replay and follow

```
GET    /api/sessions/:id/events   ?follow=true&fromSeq=N   → text/event-stream
```

The read side of chat: a session's full transcript, and — with `?follow=true` — the live tail of
whatever turn is running next, whether or not that turn was started by *this* connection.
Read-only: it never enqueues a turn and never rehydrates a cold session (evicted, or untouched
since the last server restart) into the in-memory registry — a registry miss here just means
"read straight from the store." Rehydration only ever happens as a side effect of the *next*
`POST /api/chat` on that session.

**404 `session_not_found`** up front, before the stream opens, if `:id` is unknown to both the
in-memory registry and the on-disk store — same pre-stream guarantee `POST /api/chat` makes for
its own existence checks.

**Two modes.** Without `follow` (or `follow` anything other than the literal string `"true"`):
pure replay — every stored event from `fromSeq` onward, then a `done` event, then the stream
closes. With `?follow=true`: replay, then the stream **stays open** and keeps delivering new
events as they happen, across idle gaps between turns — a `turn-boundary` finishing is *not* a
close condition, so a second tab watching a session doesn't go blind the moment the turn it
happened to catch finishes. It closes only on client disconnect (or, today, the server process
exiting — session deletion has no way to signal an open follow stream yet, since there is no
delete endpoint; see `DELETE /api/sessions/:id`, T3.1, not yet built).

**Every event derived from a stored record carries `seq` in its `data`** — replayed or freshly
live, identically — which is what makes `seq` usable as a reconnect cursor regardless of which
half of the stream delivered the last event a client saw. `text` deltas that arrive live (no
backing stored record — deltas are never persisted) carry no `seq`.

**`fromSeq` is inclusive, and the sole reconnect mechanism.** Passing the `seq` of a record
already seen re-delivers that same record — a reconnecting client that has consumed through
`seq` N must pass `fromSeq=N+1`, not `N`. There is deliberately no `Last-Event-ID` support: the
web client's SSE reader is fetch-based and does not read `id:` lines, so `fromSeq` is the only
cursor this contract offers.

**`operator` and every event from the Chat table above** can appear here exactly as they would
on `POST /api/chat`'s own stream — replay reconstructs the same wire sequence a live viewer would
have seen, via the identical mapping code. One addition that `POST /api/chat` cannot ever produce
on its own stream:

| event | data | meaning |
|---|---|---|
| `turn.interrupted` | `{}` | this turn ended without completing — graceful shutdown (or any future source of the same shape) cut it off. No further events for this turn are coming; offer Retry. |

A plain, silently-ended turn (nothing further, no `turn.interrupted`, no trailing `error`) should
not be assumed complete either — a truncated transcript with no closing marker at all means the
server crashed mid-turn (the torn-tail case): the next `POST /api/chat` on that session resumes
the underlying SDK session at its last completed turn regardless.

**Heartbeats** work identically to `POST /api/chat`'s (an SSE comment line every 5 seconds).

## Wire types

The endpoints above return the pillars' domain types. Their authoritative shapes live with
their owners — `Volume`/`Chapter` in `@shadow/core`, `IndexDocument` in `@shadow/indexing`
(schema in `INDEXING.md`), `SourceRecord`/`Claim`/`LedgerEvent`/audit results in
`@shadow/evidence` (schema in `EVIDENCE.md`). This document deliberately does not restate
them: a second copy of a schema is a second thing to drift.

**Dates cross the wire as ISO-8601 strings**, not `Date` objects. Everything else serializes
as-is.

The one thing a client must not have to reconstruct is which claims failed. Audit responses
carry findings keyed by **claim label** (the `[^label]` from D18), because that is the stable
identity the operator sees in the Markdown and the only key a UI can join on.

### `claim.restated` carries its chapter

The ledger is volume-wide, but a restatement belongs to one chapter — and D9's whole point is
that the operator can see *what Shadow softened in this chapter and why*. Without a `chapter`
field a client has to cross-reference the chapter's claim list to scope the list, which is
both fiddly and wrong at the edges (a label deleted from a chapter still has ledger history).

So `claim.restated` events include `chapter`, matching `audit.completed`. **This is a change
to `@shadow/evidence`'s `ClaimRestatedEvent`, not just to this document** — tracked as T3.6.

## Session continuation

`sessionId` arrives **only** on the `session` event, which is always the first event of a
`POST /api/chat` stream. The client stores it and echoes it on the next `POST /api/chat`. There
is no other channel — a client that misses it starts a new conversation and pays the
~18k-token preamble again (D6).

Continuation survives more than the client remembering the id. A page reload, a second browser
tab on the same session, or the server itself restarting all resolve the same way: replay via
`GET /api/sessions/:id/events` (above) rebuilds the transcript from the store, and
`?follow=true` picks up a turn still running server-side exactly where it is, live tail included
— nothing about the turn depended on the original request staying open. Any number of tabs can
watch the same session this way; only sending a message (`POST /api/chat`) requires the id.

## Errors

```jsonc
{ "error": { "code": "volume_not_found", "message": "…", "details": {} } }
```

Codes are stable strings derived from the typed errors the pillars already throw. `4xx` for
operator error, `5xx` only for genuine faults. **A failing audit is not an error** — it is a
successful request with a failing verdict, and must render as such.

**`@shadow/api` also throws a few errors of its own**, not derived from any pillar — chat/session
transport concerns that have no pillar to originate from:

| code | status | from | meaning |
|---|---|---|---|
| `session_not_found` | 404 | `POST /api/chat`, `GET /api/sessions/:id/events` | `sessionId`/`:id` is unknown to both the live registry and the on-disk store |
| `turn_queue_busy` | 409 | `POST /api/chat` | this session already has 4 turns queued ahead of this one (multiple tabs racing one session); back off and retry, or wait for the in-flight turn |
| `shutting_down` | 503 | `POST /api/chat` | the server is winding down in-flight turns and is not accepting new ones; retry once it has restarted |

## Not in scope

No auth, no multi-user, no remote hosting. This is a local single-operator prototype and
inventing an auth story would be scope we were not asked for. The server binds to localhost.
