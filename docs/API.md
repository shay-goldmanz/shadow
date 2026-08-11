# API contract

The transport between `@shadow/web` (the operator's interface) and everything beneath it.
`@shadow/api` implements this; `@shadow/web` consumes it. Both are built against this
document rather than against each other.

**The API is a transport adapter, not a place where behaviour lives.** It holds no domain
logic. Every endpoint is a thin call into `@shadow/agent`, `@shadow/core`, `@shadow/indexing`,
or `@shadow/evidence`. If something needs deciding, it gets decided in a pillar, not here.

Served by `Bun.serve` on `localhost`. JSON in, JSON out, except the chat stream.

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
| `session` | `{ sessionId }` | first event; echo it back to continue the conversation (D6 session reuse) |
| `text` | `{ delta }` | assistant prose, incremental |
| `research.started` | `{ brief }` | Shadow delegated a research brief |
| `research.source` | `{ sourceId, url, title }` | a source was retrieved and snapshotted |
| `research.finished` | `{ briefId, findings }` | findings returned, bound to sources |
| `chapter.drafted` | `{ volume, chapter }` | a chapter was written |
| `audit` | `{ chapter, verdict, findings }` | audit result — **may be a failure** |
| `chapter.restated` | `{ claim, from, to, reason, outcome }` | conservative repair, or an escalation |
| `indexed` | `{ volume, stats }` | reindex completed |
| `error` | `{ message, code }` | terminal for this turn |
| `done` | `{}` | turn complete |

`sessionId` must be echoed by the client on the next message. Without it every turn pays the
~18k-token preamble (D6).

`chapter.restated` is deliberately visible in the stream: D9 requires that what Shadow softened
and why stays in front of the operator rather than being quietly cleaned up.

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
