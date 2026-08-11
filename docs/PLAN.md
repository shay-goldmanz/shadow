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
| 1 — Foundation | ✅ complete — 386 tests passing |
| 2 — Capability | ✅ complete (bar T2.7) — 733 tests passing |
| 3 — Surfaces | ✅ complete — 918 tests passing, walked by hand |
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
| T1.1 | `@shadow/core`: Volume/Chapter domain model, `VolumeStore` port + filesystem impl, slug rules, frontmatter parsing. Unit tested. | `packages/core` | — | ✅ `5e7aa03` |
| T1.2 | `@shadow/model`: structured-generation port + agentic-session port, the two adapters from D5, session reuse, **no-API-key guardrail test** | `packages/model` | T1.1 | ✅ `b784228` |
| T1.3 | `@shadow/evidence`: package scaffold + domain model (Source, Snapshot, EvidenceSpan, Claim, Ledger) + append-only store + Tier 0 checks. Spec: `docs/EVIDENCE.md`. | `packages/evidence` | T1.1 | ✅ `95c93ba` |
| T1.4 | `@shadow/core`: close the two gaps T2.2 found — corpus-level index slot, volume routing frontmatter, chapter relative-path accessor | `packages/core` | T1.1 | ✅ `f02692f` |

T1.2 and T1.3 run in parallel once T1.1 lands — different packages, no shared files.

**Wave 1 review checkpoint.** ✅ Done. Fable reviewed all four foundation packages read-only and
verified every finding by execution. Three findings were holes in guarantees the architecture
called *structural*: operator claims never checked their source was a session transcript (the
D19 loophole), source records could be minted rather than witnessed, and evidence built paths
from unvalidated JSON. Plus a measured 66-second fuzzy-anchor in a "milliseconds" path, an
`inputHash` collision, and a frontmatter round-trip that could write unreadable chapters.
Resolved into D22 and D23; fixes tracked below.

| # | Fix task | Owns | State |
|---|---|---|---|
| R1 | Evidence hardening: session-transcript provenance (C-1), bounded fuzzy anchoring (C-2 — 61,910 ms → 1.50 ms), path re-validation (C-3), injective `inputHash`, D22 orphan split, D23 witnessed origination | `packages/evidence` | ✅ `df08027` |
| R2 | Fail-closed structured-generation guardrail + offline tests; reserved frontmatter keys; drop legacy `volume.json`; corpus-index tests | `packages/model`, `packages/core` | ✅ `d8fb80d` |
| R3 | Share `nfc-ws-v1` with evidence; deliver the D16 end-to-end property; body-read deadline; refuse non-2xx | `packages/research` | ✅ |

## Wave 2 — Capability

The pillars that do real work. This is where the acceptance criteria are won or lost.

| # | Task | Owns | Depends on | State |
|---|---|---|---|---|
| T2.1a | `@shadow/research`: retrieval transport — live web + fixture record/replay (D2). No evidence coupling. | `packages/research` | T1.1 | ✅ `e5f0c85` |
| T2.1b | `@shadow/research`: research-brief port and tool-agents that fetch and snapshot sources into the evidence ledger | `packages/research` | T2.1a, T1.2, T1.3 | ✅ |
| T2.2 | `@shadow/indexing`: `Indexer` — structural tree from headings + `when_to_use`/`not_for` frontmatter vocabulary; stable node identity; O(changed subtree) rebuild. **Zero LLM calls** (D11). | `packages/indexing` | T1.1 | ✅ `5b04a5d` |
| T2.3 | `@shadow/indexing`: `Navigator` — agent-as-locator over the chapter index (D11a), `1/√(N+1)·Σ` rollup, ancestor-closure expansion, passages in document order, grade step ≤3 rounds. Also adopt core's corpus index slot and `chapterRelativePath`. | `packages/indexing` | T2.2, T1.4 | ✅ `1cb457a` |
| T2.4 | `@shadow/evidence`: CoE Audit — source integrity, span entailment, claim completeness (checks 1–3 of D9), plus C5 chapter relevance as a non-blocking warning (D15) | `packages/evidence` | T1.3, T1.2 | ✅ |
| T2.5 | `@shadow/evidence`: index-alignment check (check 4 of D9) + conservative-restatement repair | `packages/evidence` | T2.4, T2.2 | ✅ |
| T2.6 | `@shadow/indexing`: `shadow lint` self-critique — discriminability, self-retrieval coverage, orphans, contradictions, miss log (D14) | `packages/indexing` | T2.3 | ✅ |
| T2.7 | Reconcile the two miss logs: the CLI wrote its own at `<SHADOW_HOME>/misses.jsonl`, T2.6 built a `MissLogStore` port and left the path to the CLI. Wire the CLI to `FileMissLog`. | `packages/cli` | T2.6, T3.1 | ✅ `1a70b31` |
| T2.8 | `@shadow/indexing`: BM25 has no stopword filtering, so function-word overlap scores > 0 and promotes weak guesses instead of an honest miss (found by T4.5). Also `FileMissLog.readAll()` loses the whole backlog on one malformed line (found by T2.7). | `packages/indexing` | T2.6 | ⬜ |

T2.1 runs parallel with T2.2. T2.4 runs parallel with T2.2/T2.3. T2.3 and T2.5 are sequenced.

**Wave 2 review checkpoint.** ✅ Done — and the gate failed on its own terms. Fable
demonstrated by execution that **a fabricated claim passed the entire audit**: C2 resolved
fuzzily against an immutable pinned snapshot, and the entailment judge read the writer's own
copy of the quote rather than the stored bytes, so a fabricated quote was checked against
itself. Also found: unmarked claims in list items escaped both the sweep and the exemption
budget; a derived claim was not re-judged when its support's meaning changed; C4 could replay a
stale pass; and the lint navigator routed without ever seeing the task it was routing.
Resolved into D24/D25; fixes below.

| # | Fix task | Owns | State |
|---|---|---|---|
| F1 | Exact-only integrity resolution; judge reads stored bytes; list items segmented; transitive `supports` hashing; C4 memo key | `packages/evidence` | ✅ `c41f24a` |
| F2 | Give the navigator its task; cost-model gate; wire the rollup; BM25 stopwords; per-line miss-log recovery | `packages/indexing` | ✅ `cd7ac57` |

## Wave 3 — Surfaces

| # | Task | Owns | Depends on | State |
|---|---|---|---|---|
| T3.1 | `@shadow/cli`: `discover`, `navigate`, `read` commands; composable Unix-citizen surface with in-band `next_steps` steering (D12) | `packages/cli` | T1.1, T2.3 | ✅ `0b43c98` |
| T3.2 | Skills: volume-writing skill guiding Shadow, consumer skill for coding agents, `shadow install` to place it | `skills/`, `packages/cli` | T3.1 | ✅ |
| T3.3 | `@shadow/agent`: Shadow — intent handling, research delegation, skill-guided chapter writing, reindex triggering | `packages/agent` | T2.1, T2.2, T2.4 | ✅ `b408513` |
| T3.4 | `@shadow/api`: Bun HTTP server, volume CRUD, SSE streaming of Shadow's turns | `packages/api` | T3.3 | ✅ `bbefee7` |
| T3.5 | `@shadow/web`: React SPA — volume list, create, chat, chapter + index-tree viewer. Implements the D10 design language exactly; the semantic colour rule makes evidence legible in the UI. | `packages/web` | T3.4 | ✅ `6dd1be1` |
| T3.6 | `@shadow/evidence`: add `chapter` to `ClaimRestatedEvent` so a restatement can be scoped to its chapter without cross-referencing (found by T3.5) | `packages/evidence` | T2.5 | ✅ `43fe60b` |
| T3.7 | Point the API at `SHADOW_HOME` — it read `SHADOW_ROOT`, so any override split the API's corpus from the CLI's. Found by running both halves together. | `packages/api` | T3.4 | ✅ `a24c05a` |

T3.1→T3.2 and T3.3→T3.4→T3.5 are two mostly independent chains; the CLI chain runs parallel
with the agent chain.

**Wave 3 review checkpoint.** ⚠️ Failed on the operator's half. A hand smoke test passed, but
Fable and a Playwright browser pass both found the interface unusable: **the volume page is a
blank screen for every volume**, because `@shadow/web` was built against a *guessed* wire
contract its own fake then confirmed. Separately, `persistSession: false` combined with
`resume` meant **Shadow could not complete any multi-turn work** — so the critical path's
research-then-draft could not finish through chat at all. The CLI half held up under
adversarial live use.

| # | Fix task | Owns | State |
|---|---|---|---|
| F3 | Session persistence so reuse works; fake now models the real failure; live two-turn proof | `packages/model`, `packages/agent` | ✅ |
| F4 | Reconcile web↔API with an offline contract test; composition-root `SHADOW_HOME` and miss log; SSE lifecycle; a11y contrast (D10a) | `packages/web`, `packages/api` | ⏳ |
| F5 | The audit gate leaks through reindex: a failed chapter becomes findable after any `shadow index` | `packages/indexing`, `packages/agent` | ⬜ |
| F6 | `shadow` is on no PATH, so the installed skill's first command is "command not found" | `packages/cli`, `README.md` | ⬜ |
| F7 | Leftovers: numeric sub-check skips `derived` claims; `listSources` swallows JSON corruption; `find --volumes <typo>` yields a false `not-in-corpus` and pollutes the backlog | `packages/evidence`, `packages/cli` | ⬜ |

**The earlier hand smoke test still stands** and is what found T3.7:
Live smoke test: `POST /api/volumes` → `PUT` a chapter → the audit ran (Tier 0 plus a real
Tier 2 model call on subscription auth) → reindex → `shadow find` returned the chapter with
`next_steps` naming its real `node_id`. That run is what surfaced T3.7: the two halves of the
product were reading different environment variables and only agreed by accident of a shared
default.

## Wave 4 — Measure and prove

| # | Task | Owns | Depends on | State |
|---|---|---|---|---|
| T4.1 | `@shadow/evaluation`: fixed corpus, golden query set, retrieval metrics, `holes_ratio` (D17), **baseline recorded** | `packages/evaluation` | T2.3 | ⬜ |
| T4.2 | Baseline comparison: naive flat/keyword retrieval vs the tree navigator, to substantiate "or better" | `packages/evaluation` | T4.1 | ⬜ |
| T4.3 | Groundedness metrics: attribution rate, citation precision, injected-hallucination catch rate | `packages/evaluation` | T2.5 | ⬜ |
| T4.4 | E2E: the critical path — create volume → research Linear/Notion/Epoch → two chapters → indexed → CLI finds it. Fixture-backed. | `tests/e2e` | T3.5 | ⬜ |
| T4.5 | E2E: agent consumption — a coding agent asked for a one-pager reaches the right chapter via CLI unprompted | `tests/e2e` | T3.2 | ✅ `ba81f01` |

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
5a. **Always pass an explicit pathspec to `git commit`.** A bare `git commit -m` picks up
   whatever another agent has staged. This has happened twice.
5b. **Never rewrite history.** No `reset --hard`, no amending another agent's commit, no
   rebase. A history correction on a shared branch dropped a second agent's files back to
   untracked once already. If a commit came out wrong, fix it forward with a new commit.
5c. **Never delete a file you did not create.** An agent ran `rm -f` on an untracked
   root-level file belonging to nobody's task; untracked means git could not recover it.
   Deleting is not part of any task here unless the task says so explicitly.
6. **Commit green work before you run out of budget.** Subagents can be killed mid-task by a
   session limit. A task that dies with everything uncommitted loses all of it; one that has
   been committing incrementally loses only the last step. If a task must stop early, it
   commits what is green and reports what is missing.

## Open questions

Tracked here as they arise; resolved into `DECISIONS.md`.

- Incremental reindex granularity on chapter edit — whole-volume rebuild is simplest and may
  be fast enough at prototype scale. Decide with T2.2 in hand, measure before optimizing.
- Whether the entailment judge needs a stronger model than the rest of the stack. Decide from
  T4.3's catch rate.
