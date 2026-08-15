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

Shadow's turns stream as SSE. Event names mirror what the operator needs to *see happening*,
since research is slow and silence reads as failure:

| event | data | meaning |
|---|---|---|
| `session` | `{ sessionId }` | first event; echo it back to continue the conversation (D6) |
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
| `rulebook.started` | `{ slug, docPath }` | a `shadow:rulebook` directive began running |
| `rulebook.planned` | `{ slug, chunkCount, groups }` | taxonomy planned; `groups` is the proposed group-slug list |
| `rulebook.chunk` | `{ slug, completed, total, rulesSoFar, cached, failed }` | one chunk finished extraction |
| `rulebook.merged` | `{ slug, ruleCount, droppedQuotes, consolidated }` | rules validated and consolidated across chunks |
| `rulebook.group.audited` | `{ slug, group, passed, repairs, issues }` | one group's Chain-of-Evidence audit finished — **may be a failure** |
| `rulebook.completed` | `{ slug, result }` | `result` is the full `RulebookResult` (rule/group counts, published/rejected groups, failed chunks, usage) |
| `rulebook.failed` | `{ slug, error }` | the run failed outright; **not** an `error` event — the turn continues |
| `error` | `{ message, code }` | terminal for this turn |
| `done` | `{}` | turn complete |

**`sessionId` is the conversation's id**, stable from construction — not the underlying
`AgenticSession`'s own id, which is minted when the first turn runs. The client only ever sees
and echoes the former.

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

## Rule books

```
GET /api/rulebooks                        → { rulebooks: RulebookSummary[] }
GET /api/rulebooks/:slug                  → { rulebook, groups: GroupSummary[] }
GET /api/rulebooks/:slug/groups/:group    → { group, claims?, audit? }
```

Read-only. A rule book is only ever written by a `shadow:rulebook` chat directive
(`RuleBookPort.create`, streamed as the `rulebook.*` SSE events above) — these three endpoints
exist for a client to fetch what a run already produced, nothing more.

`RulebookSummary` is `{ slug, title, status, groupCount, updatedAt }` — the list view, one entry
per rule book, `groupCount` from `listGroups().length`. `GroupSummary` is
`{ slug, title, status, ruleCount }` — `ruleCount` is the group's footnote-marker count
(`[^label]`), cheap to compute from the already-loaded body rather than re-parsing the claim
sidecar just to count entries.

**`GET .../groups/:group` deliberately mirrors `GET .../chapters/:chapter`**: a group is a
chapter-shaped document (own claim sidecar, own audit record, keyed by
`(rulebookSlug, groupSlug)` exactly like a volume's `(volume, chapter)`), so its response has the
same shape and the same optionality — `claims`/`audit` are `undefined` until the group has been
through `publishGroup` at least once. A rule book's evidence store is a second, separate
`EvidenceStore` instance scoped over its own directory tree, not the volume evidence store.

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
stream. The client stores it and echoes it on the next `POST /api/chat`. There is no other
channel — a client that misses it starts a new conversation and pays the ~18k-token preamble
again (D6).

## Errors

```jsonc
{ "error": { "code": "volume_not_found", "message": "…", "details": {} } }
```

Codes are stable strings derived from the typed errors the pillars already throw. `4xx` for
operator error, `5xx` only for genuine faults. **A failing audit is not an error** — it is a
successful request with a failing verdict, and must render as such.

## Not in scope

No auth, no multi-user, no remote hosting. This is a local single-operator prototype and
inventing an auth story would be scope we were not asked for. The server binds to localhost.
