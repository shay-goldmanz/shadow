# Architecture

Shadow distills the operator's beliefs into curated **volumes** that coding agents can find
and reason over. This document defines the pillars, the seams between them, and the
invariants each seam enforces.

See `ACCEPTANCE.md` for what must be true, and `DECISIONS.md` for why each choice was made.

## The shape of the system

There are two distinct users, and they never share an entry point:

- **The operator** talks to Shadow through the web interface to build volumes.
- **A coding agent**, in some other repo, consumes volumes through the CLI.

Everything else exists to make the second interaction good.

```
                 OPERATOR                              CODING AGENT
                    │                                       │
                    ▼                                       ▼
            ┌───────────────┐                       ┌───────────────┐
            │  @shadow/web  │                       │  @shadow/cli  │
            └───────┬───────┘                       └───────┬───────┘
                    │ HTTP/SSE                              │ argv → JSON
            ┌───────▼───────┐                               │
            │  @shadow/api  │                               │
            └───────┬───────┘                               │
                    │                                       │
            ┌───────▼────────┐                              │
            │ @shadow/agent  │  ← Shadow, the shadow writer │
            └───┬────────┬───┘                              │
                │        │                                  │
     delegates  │        │  writes chapters                 │  navigates
                │        │                                  │
    ┌───────────▼──┐  ┌──▼──────────────┐          ┌────────▼────────┐
    │@shadow/       │  │                 │          │                 │
    │  research     │─▶│ @shadow/evidence│◀─────────│ @shadow/indexing│
    │ (tool-agents) │  │  (chain of ev.) │  audits  │  (tree + nav)   │
    └───────┬───────┘  └────────┬────────┘          └────────┬────────┘
            │                   │                            │
            └───────────────────┼────────────────────────────┘
                                ▼
                       ┌─────────────────┐      ┌──────────────────┐
                       │  @shadow/core   │      │ @shadow/evaluation│
                       │ domain + store  │      │ measures indexing │
                       └────────┬────────┘      └──────────────────┘
                                │
                                ▼
                    ~/.shadow/volumes/<slug>/
                       chapters/*.md
                       index.json
                       evidence/

           ┌──────────────────────────────────────────┐
           │ @shadow/model — the ONLY package that    │
           │ talks to an LLM. Subscription auth only. │
           └──────────────────────────────────────────┘
                    ▲ used by: agent, research, indexing, evidence, evaluation
```

## Pillars

### `@shadow/core` — domain and storage
The foundation. Volume, Chapter, and their identifiers; the `VolumeStore` interface and its
filesystem implementation. Pure: no LLM, no network, no agents. Everything that reads or
writes a volume does so through `VolumeStore` and nothing else.

**Invariant:** the filesystem layout is an implementation detail of this package. No other
package builds a path.

### `@shadow/model` — the single LLM seam
The only package permitted to import an AI SDK. Exposes two narrow ports — structured
generation (Zod-typed, tool-less) and agentic sessions (tools, skills, subagents) — over the
two transports in D5. Owns session reuse and the preamble-cost budget from D6.

**Invariant:** the entire stack runs on the operator's subscription. This package fails loudly
rather than fall back to an API key, and it is the only place that could ever do either.

### `@shadow/research` — offloaded heavy lifting
Tool-agents that go and find things. Acceptance requires that fetching data for volumes is
*offloaded from Shadow*, so Shadow never fetches: it delegates a research brief and receives
findings that are already bound to retrieved sources.

Retrieval goes through a transport port so tests swap live web for recorded fixtures (D2)
without the research logic knowing.

**Invariant:** this is the only pillar that may originate a source record, and only from a
real retrieval. That is what makes fabricated citations structurally impossible rather than
merely discouraged.

### `@shadow/evidence` — the chain of evidence
Source records with content-hashed snapshots, evidence spans, claims, and the append-only
ledger binding them. Implements the CoE Audit's four checks (D9): source integrity, span
entailment, claim completeness, index alignment.

**Invariant:** a chapter that fails the audit is not publishable. Completeness and correctness
are enforced here or nowhere.

### `@shadow/indexing` — PageIndex-like tree and reasoning-based navigation
Builds a hierarchical index over a volume when it is created or edited, and navigates that
tree by reasoning rather than vector similarity. Two ports behind one package: `Indexer`
(build) and `Navigator` (retrieve), both pluggable so strategies can be swapped and compared.

**Invariant:** the index is derived state. It can always be rebuilt from chapters, and is
never a source of truth. Index summaries are themselves audited for groundedness.

### `@shadow/agent` — Shadow
The user-facing chat agent, and the only agent the operator speaks to. Orchestrates:
interprets intent, delegates research, writes chapters under skill guidance, triggers
reindexing. Deliberately thin on capability and rich on judgment — the work happens in the
pillars beneath it.

**Invariant:** Shadow writes only what it can cite.

### `@shadow/cli` — the agent-facing contract
The `shadow` binary. Discovery (`which volume, if any?`), navigation (reasoning over the
tree), and reading. Output is JSON, terse, and token-cheap — its consumer is a language model
with a budget, not a human.

Ships an installable skill so a coding agent knows *when* to reach for it unprompted (D3).

**Invariant:** the CLI is the whole contract. If an agent needs it, it is here.

### `@shadow/api` and `@shadow/web` — the operator's interface
A Bun HTTP server streaming Shadow's responses, and a React SPA over it. The SPA holds no
domain logic; the API is a transport adapter, not a place where behavior lives.

### `@shadow/evaluation` — measured indexing effectiveness
A golden query set over a fixed corpus, scoring retrieval against known-correct chapters. Its
purpose is to make "PageIndex-like-**or better**" a measured claim rather than an assertion,
and to catch regressions when indexing changes.

**Invariant:** a baseline is established before the index is tuned. Improvements are reported
against it.

## The seams that matter

Four boundaries carry the design. Each isolates a risk that would otherwise be spread across
the codebase:

| Seam | Isolates | So that |
|---|---|---|
| `VolumeStore` | storage layout | SQLite or remote storage can replace files without touching a caller |
| `@shadow/model` ports | LLM transport + auth | the no-API-keys rule is enforceable in one file, and providers are swappable |
| `Indexer` / `Navigator` | retrieval strategy | strategies are comparable and measurable, not baked in |
| research transport | network | e2e tests run offline and deterministically |

## Data flow: creating a volume

1. Operator creates a volume in the web UI. `@shadow/core` writes an empty volume.
2. Operator tells Shadow what they believe in. Shadow forms research briefs.
3. Shadow delegates each brief to `@shadow/research`. Tool-agents retrieve real sources,
   snapshot them, and record them in `@shadow/evidence`.
4. Shadow drafts chapters under skill guidance, citing evidence spans.
5. The CoE Audit runs. Unsupported claims are restated conservatively against their source —
   not deleted, so the operator can see where the volume is thin.
6. `@shadow/indexing` builds the tree. Node summaries are audited for alignment.
7. Volume is on disk, indexed, and visible to the CLI.

## Data flow: an agent using a volume

1. Coding agent hits a task its skill associates with the operator's way of working.
2. It runs `shadow` to discover whether a relevant volume exists.
3. It navigates the index tree by reasoning, not similarity, to the right chapter.
4. It reads the chapter — and can follow citations back to sources if it needs to.
