# Plan

Working plan for the Shadow prototype. Kept current as work lands — task status here is the
source of truth for progress.

**Method.** Breadth-first: build the full skeleton of every pillar before deepening any one of
them, so the seams are proven early and the expensive layers (indexing, evidence) are measured
rather than guessed. One task, one subagent, one commit. Review in waves at milestones.

**Definition of done for the prototype:** every line in `ACCEPTANCE.md` demonstrably true,
with the critical path runnable end to end and indexing effectiveness measured against a
baseline.

## Status

| Wave | State |
|---|---|
| 0 — Groundwork | ✅ complete |
| 1 — Foundation | ⏳ in progress |
| 2 — Capability | ⬜ not started |
| 3 — Surfaces | ⬜ not started |
| 4 — Measure and prove | ⬜ not started |

## Wave 0 — Groundwork ✅

| # | Task | State |
|---|---|---|
| T0.1 | Research: PageIndex, Science One, subscription auth, TS7+Bun | ✅ |
| T0.2 | Decide architecture; write `DECISIONS.md`, `ARCHITECTURE.md`, `PLAN.md` | ✅ |
| T0.3 | Scaffold Bun workspace monorepo, TS 7, oxlint/Biome/`bun test`, CI | ✅ `88107d4` |

## Wave 1 — Foundation

The layers everything else stands on. No feature work until these are green.

| # | Task | Owns | Depends on | State |
|---|---|---|---|---|
| T1.1 | `@shadow/core`: Volume/Chapter domain model, `VolumeStore` port + filesystem impl, slug rules, frontmatter parsing. Unit tested. | `packages/core` | — | ⬜ |
| T1.2 | `@shadow/model`: structured-generation port + agentic-session port, the two adapters from D5, session reuse, **no-API-key guardrail test** | `packages/model` | T1.1 | ⬜ |
| T1.3 | `@shadow/evidence`: package scaffold + domain model (Source, Snapshot, EvidenceSpan, Claim, Ledger) + append-only store. No LLM checks yet. | `packages/evidence` | T1.1 | ⬜ |

T1.2 and T1.3 run in parallel once T1.1 lands — different packages, no shared files.

**Wave 1 review checkpoint.** Fable reviews the seams; Opus plans revisions; Sonnet applies.
Gate: are `VolumeStore` and the model ports the right shape to build on?

## Wave 2 — Capability

The pillars that do real work. This is where the acceptance criteria are won or lost.

| # | Task | Owns | Depends on | State |
|---|---|---|---|---|
| T2.1 | `@shadow/research`: research-brief port, retrieval transport (live web + fixture recorder per D2), tool-agents that fetch and snapshot sources into the evidence ledger | `packages/research` | T1.2, T1.3 | ⬜ |
| T2.2 | `@shadow/indexing`: `Indexer` — build the PageIndex-like tree over a volume; node schema, summaries, incremental rebuild on edit | `packages/indexing` | T1.2 | ⬜ |
| T2.3 | `@shadow/indexing`: `Navigator` — reasoning-based traversal to select nodes, with retrieval trace | `packages/indexing` | T2.2 | ⬜ |
| T2.4 | `@shadow/evidence`: CoE Audit — source integrity, span entailment, claim completeness (checks 1–3 of D9) | `packages/evidence` | T1.3, T1.2 | ⬜ |
| T2.5 | `@shadow/evidence`: index-alignment check (check 4 of D9) + conservative-restatement repair | `packages/evidence` | T2.4, T2.2 | ⬜ |

T2.1 runs parallel with T2.2. T2.4 runs parallel with T2.2/T2.3. T2.3 and T2.5 are sequenced.

**Wave 2 review checkpoint.** Gate: does the index actually retrieve well, and does the audit
actually catch an injected hallucination? Both must be shown, not asserted.

## Wave 3 — Surfaces

| # | Task | Owns | Depends on | State |
|---|---|---|---|---|
| T3.1 | `@shadow/cli`: `discover`, `navigate`, `read` commands; terse JSON output tuned for token cost | `packages/cli` | T1.1, T2.3 | ⬜ |
| T3.2 | Skills: volume-writing skill guiding Shadow, consumer skill for coding agents, `shadow install` to place it | `skills/`, `packages/cli` | T3.1 | ⬜ |
| T3.3 | `@shadow/agent`: Shadow — intent handling, research delegation, skill-guided chapter writing, reindex triggering | `packages/agent` | T2.1, T2.2, T2.4 | ⬜ |
| T3.4 | `@shadow/api`: Bun HTTP server, volume CRUD, SSE streaming of Shadow's turns | `packages/api` | T3.3 | ⬜ |
| T3.5 | `@shadow/web`: React SPA — volume list, create, chat, chapter + index-tree viewer | `packages/web` | T3.4 | ⬜ |

T3.1→T3.2 and T3.3→T3.4→T3.5 are two mostly independent chains; the CLI chain runs parallel
with the agent chain.

**Wave 3 review checkpoint.** Gate: can the operator walk the critical path by hand?

## Wave 4 — Measure and prove

| # | Task | Owns | Depends on | State |
|---|---|---|---|---|
| T4.1 | `@shadow/evaluation`: fixed corpus, golden query set, retrieval metrics, **baseline recorded** | `packages/evaluation` | T2.3 | ⬜ |
| T4.2 | Baseline comparison: naive flat/keyword retrieval vs the tree navigator, to substantiate "or better" | `packages/evaluation` | T4.1 | ⬜ |
| T4.3 | Groundedness metrics: attribution rate, citation precision, injected-hallucination catch rate | `packages/evaluation` | T2.5 | ⬜ |
| T4.4 | E2E: the critical path — create volume → research Linear/Notion/Epoch → two chapters → indexed → CLI finds it. Fixture-backed. | `tests/e2e` | T3.5 | ⬜ |
| T4.5 | E2E: agent consumption — a coding agent asked for a one-pager reaches the right chapter via CLI unprompted | `tests/e2e` | T3.2 | ⬜ |

**Final review.** Full acceptance-criteria walkthrough, each line evidenced.

## Testing posture

A few good e2e tests over coverage; unit tests only where correctness is subtle.

- **E2E (fixture-backed, offline):** T4.4 and T4.5 — the two paths that *are* the product.
- **Unit, critical only:** `VolumeStore` round-trips and slug/frontmatter edge cases; the
  no-API-key guardrail; evidence ledger append-only semantics and hash integrity; tree
  navigation node selection; audit check behavior on a known-bad chapter.
- **Not unit tested:** transport adapters, the SPA, CLI arg parsing beyond a smoke test.

## Parallelism rules for subagents

1. A task owns its listed paths exclusively. No task edits another's package.
2. Nobody but the orchestrator edits `ACCEPTANCE.md`, `DECISIONS.md`, `ARCHITECTURE.md`, or
   `PLAN.md`.
3. Shared root config (`package.json`, `tsconfig.base.json`) is orchestrator-only after T0.3.
   A task needing a dependency added says so in its report instead of editing the root.
4. Every task ends green: `bun run check` passes before its commit.
5. Stage by name, never `git add -A` — concurrent work may be in the tree.

## Open questions

Tracked here as they arise; resolved into `DECISIONS.md`.

- Incremental reindex granularity on chapter edit — whole-volume rebuild is simplest and may
  be fast enough at prototype scale. Decide with T2.2 in hand, measure before optimizing.
- Whether the entailment judge needs a stronger model than the rest of the stack. Decide from
  T4.3's catch rate.
