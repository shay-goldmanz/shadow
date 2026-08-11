# Decisions

Architectural decision record for Shadow. Newest decisions appended at the bottom.
Each entry: context, the decision, why, and what it costs us.

---

## D1 — Interface is a local web app

**Context.** Acceptance requires an "interface" where the operator creates a volume and
chats with Shadow. Options were a local web app, a TUI, or CLI-only.

**Decision.** A Bun-served React SPA on `localhost`. Volume list, create-volume, streaming
chat with Shadow, and a chapter + index-tree viewer.

**Why.** Two of the artifacts the operator must judge — drafted chapters and the index tree
— are structurally visual. A TUI reads long-form Markdown badly and renders a nested tree
worse. CLI-only would arguably fail the "operator opens interface" line of the critical path.

**Cost.** Largest build surface of the three. Mitigated by keeping the SPA thin: it holds no
domain logic, only calls `@shadow/api`.

---

## D2 — Research fetches live web at runtime, fixtures in tests

**Context.** The critical path has Shadow extrapolating how Linear/Notion design UI and how
Epoch designs one-pagers. That implies real external data.

**Decision.** Research tool-agents use live web search/fetch at runtime. Every e2e test runs
against a recorded fixture corpus behind the same port interface.

**Why.** Proves the real path while keeping tests deterministic and offline. Non-negotiable
for the measured indexing baseline — a moving corpus makes retrieval scores meaningless.

**Cost.** A fixture-recording mechanism to build and keep fresh.

---

## D3 — Agents consume volumes via CLI + an installable skill

**Context.** "Agent invokes the CLI without being explicitly asked to."

**Decision.** Ship a `shadow` binary plus a `SKILL.md` that `shadow install` drops into a
target repo's `.claude/skills/`. The skill tells the coding agent *when* to reach for volumes.

**Why.** Acceptance names the CLI explicitly, so the CLI is the contract. Unprompted
invocation is a discovery problem, not a transport problem — that is exactly what a skill
solves. An MCP server would be additive scope against criteria that already say "CLI".

**Cost.** Discovery depends on the host agent honoring skills. Acceptable: the target
consumer is Claude Code.

---

## D4 — Volumes are git-friendly files on disk

**Context.** Volumes are curated beliefs the operator will want to read, diff, and correct.

**Decision.** `~/.shadow/volumes/<slug>/` with chapters as Markdown + YAML frontmatter and
`index.json` holding the index tree. Filesystem is the single source of truth.

**Why.** Human-readable, diffable, hand-editable, and versionable with git. For a prototype
about distilling *beliefs*, the operator being able to open and correct the artifact matters
more than query latency. SQLite would be opaque at exactly the wrong moment.

**Cost.** Linear scans at scale. Irrelevant at prototype volume counts; if it bites, a
derived SQLite cache slots in behind the same store interface without touching callers.

---

## D5 — Model access splits across two transports behind one port

**Context.** Acceptance is absolute: *"The entire stack runs on the operator's AI
subscriptions, NOT on api keys."* The guideline was to use Vercel's AI SDK with a Claude
adapter. Research verified on this machine that `@anthropic-ai/claude-agent-sdk` inherits
Claude Code's OAuth credentials — a live call returned `apiKeySource: none`, subscription
`Claude Max`, with `ANTHROPIC_API_KEY` unset. It also found that
`ai-sdk-provider-claude-code` **silently ignores AI SDK `tools`**: the provider emits a
"feature not supported" warning and the model never sees the tool.

**Decision.** One port, `@shadow/model`, with two adapters behind it:

| Workload | Transport | Rationale |
|---|---|---|
| Structured, tool-less generation — index node summaries, tree synthesis, retrieval node selection, eval judging | Vercel AI SDK `generateObject` via `ai-sdk-provider-claude-code` | Zod-typed output, no tools needed, clean ergonomics |
| Agentic, tool-heavy — Shadow chat, research tool-agents, skill-guided writing | `@anthropic-ai/claude-agent-sdk` `query()` directly | Needs real tools, skills, and subagents |

No caller outside `@shadow/model` imports either SDK.

**Why.** This honors the AI SDK guideline where it genuinely pays (typed structured output,
which is most of the indexing pillar) without pretending its tool bridging works. Routing
agentic work through the adapter would mean re-expressing every tool as an MCP server just
to satisfy a layer that then discards the schema. Isolating both in one package keeps the
no-API-keys constraint enforceable at exactly one seam.

**Cost.** Two SDKs to keep on compatible versions — the adapter pins the Agent SDK, so they
must move together. The seam makes that a one-package problem.

**Guardrail.** A test asserts `ANTHROPIC_API_KEY` is never read by our code, and the model
package fails loudly if it ever resolves credentials from an API key.

---

## D6 — Every `query()` session is expensive; sessions get reused

**Context.** Research measured a trivial one-word completion costing ~18k cache-write tokens,
because the Claude Code system preamble is charged on each fresh session.

**Decision.** `@shadow/model` owns session lifecycle and reuses sessions via `resume` for
multi-turn work. Indexing fans out over many small structured calls, so the indexer batches
node summarization into as few sessions as correctness allows.

**Why.** Naive per-node sessions would make indexing a large volume cost more in preamble
than in actual work.

**Cost.** Session state to manage. Contained inside the model package.

---

## D7 — No build step: Bun runs TypeScript source directly

**Context.** TypeScript 7.0.2 is GA (package `typescript@7`, binary `tsc` — the `tsgo` binary
and `@typescript/native-preview` are both gone). Bun 1.3.14 executes TypeScript natively.

**Decision.** Internal packages set `exports` to their `.ts` source. No `dist/`, no compile
step, no project references. `tsc` runs purely as a type-checker under `noEmit`, fanned out
with `bun --filter '*' typecheck`.

**Why.** Nothing here publishes to npm, so declaration emit buys nothing and costs a build
graph. It also removes the stale-`dist` class of bug entirely — every run reads the source
the tests type-checked. TS 7 forbids `composite: true` with `noEmit: true`, so the choice is
genuinely either/or; without a publishing requirement, no-build wins.

**Cost.** If a package ever needs publishing, it moves to composite emit on its own. The
`exports` field is the only thing that changes for consumers.

---

## D8 — oxlint for linting, Biome for formatting, `bun test` for tests

**Context.** TypeScript 7.0 ships **no programmatic API** (slated for 7.1). typescript-eslint
is consequently broken on TS 7 and the maintainers have deferred support.

**Decision.** `oxlint` + `oxlint-tsgolint` for linting including type-aware rules; Biome with
its linter disabled for formatting and import sorting; `bun test` for all tests.

**Why.** This is forced, not preferred — the conventional ESLint stack cannot run on our
compiler. oxlint's type-aware mode delegates to `tsgolint`, which wraps the same Go compiler
core as TS 7, so it is natively compatible and versioned against it. `bun test` already
covers what we need for both unit and e2e work (coverage, watch, JUnit, `--isolate`,
`--no-orphans` for server-spawning e2e), and adding Vitest would drag in a parallel Vite
toolchain for no gain.

**Cost.** Two tools instead of one, and a known sharp edge: under Bun's default isolated
linker oxlint follows workspace symlinks and errors unless `ignorePatterns` excludes
`node_modules`. Encoded in `.oxlintrc.json` from the start.

**Consequence to watch.** No TS 7 programmatic API also rules out ts-morph and custom
transformers. Nothing in the planned architecture needs them.

---

## D9 — Evidence is a pillar, not a feature

**Context.** The operator added an acceptance criterion mid-build: a Science One–like chain of
evidence, so no volume content is hallucinated. Google Research's Science One framework
defines the chain of evidence as two properties — **completeness** ("every claim in a research
artifact must carry a recorded evidence chain") and **correctness** ("each chain must
genuinely support the claim it is attached to") — enforced by a *CoE Audit* of four integrity
checks, and it deliberately specifies properties rather than implementation.

**Decision.** Add a tenth package, `@shadow/evidence`, owning the source/evidence/claim data
model, the append-only evidence ledger, and the audit. `@shadow/research` produces evidence
into it; `@shadow/agent` may only write chapter content that cites it; `@shadow/evaluation`
measures it. Chapters are unpublishable until they pass the audit.

**Why.** Grounding is a cross-cutting invariant over research, writing, and indexing. If it
lived inside the research package it would be advisory, and Shadow could still write
ungrounded prose. As a separate pillar with its own store, it becomes a gate every chapter
must pass. Making it a package also makes it independently testable offline — the audit runs
against stored snapshots with no network.

**How the four Science One checks map to our domain:**

| Science One | Shadow |
|---|---|
| Reference verification — bibliography cross-checked against academic APIs | **Source integrity** — every cited source was actually retrieved, and its stored snapshot's content hash still matches. Kills fabricated citations structurally: you cannot cite what was never fetched. |
| Score verification — re-run code, compare reported numbers | **Span entailment** — the cited excerpt is checked to actually support the claim, via an LLM judge over the stored snapshot. |
| Specification violation — does the code solve the task | **Claim completeness** — every claim-bearing sentence in a chapter carries an evidence tag; orphan claims fail the audit. |
| Method–code alignment — LLM judge, paper vs implementation | **Index alignment** — index node summaries introduce no claim absent from the chapter body. |

**Why the fourth check is ours and matters.** The index is generated content too, and it is
what a consuming agent retrieves and reasons over first. An ungrounded node summary would
poison retrieval while the chapter beneath it stayed clean. Auditing the index is the piece a
naive port of Science One would miss.

**Following Science One on repair:** claims that outrun their evidence are *restated
conservatively against the source, not deleted*. Silent deletion would hide the failure from
the operator; the point is that they see where their volume is thin.

**Cost.** An LLM judging pass per chapter edit, and snapshot storage for every source. Both
are bounded — snapshots are text, and entailment runs only over claims whose evidence changed.

**Guardrail.** Research tool-agents are the *only* code permitted to originate a source
record, and they can only do so from an actual retrieval. Shadow cannot mint a citation.

---

## D10 — Design language: quiet, archival, pastel-on-paper

**Context.** The operator asked for a clean, minimal, professional UI in the neighbourhood of
Notion and Linear's design language — but our own, not a copy.

**Decision.** A defined token set, committed before the SPA is built, so the look is a spec
rather than an accumulation of choices.

**Positioning.** Linear is high-contrast, dark-first, saturated indigo, dense and fast —
it reads as *velocity*. Notion is near-monochrome warm grey, generous whitespace, near-zero
chrome — it reads as *neutral surface*. Shadow is neither: it is an archive of considered
belief, so it should read as **quiet and deliberate**. We take Linear's structural
discipline (tight alignment, restrained borders, purposeful density) and Notion's calm
content-first typography, then diverge on colour: warm paper neutrals rather than cool grey,
with desaturated pastel accents that carry meaning instead of decorating.

**Palette.** Warm paper ground, ink-navy text, muted sage as primary, dusty clay as the
counterweight. Accents are desaturated enough to sit under body text without competing.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#FBFAF7` warm paper | `#14161A` | page ground |
| `--surface` | `#FFFFFF` | `#1B1E23` | cards, panels |
| `--surface-sunken` | `#F4F2ED` | `#101216` | wells, code, tree gutter |
| `--border` | `#E6E2D9` | `#2A2E35` | hairlines, 1px only |
| `--text` | `#1F2429` ink navy | `#E8E6E1` | body |
| `--text-muted` | `#6B7280` | `#9AA0A8` | metadata, timestamps |
| `--accent` | `#7C9885` muted sage | `#8FAE97` | primary action, active nav |
| `--accent-soft` | `#E8EFE9` | `#232B26` | selected row, active tab fill |
| `--clay` | `#C08A72` dusty clay | `#CE9A83` | citations, evidence links |
| `--warn` | `#C9A227` | `#D9B540` | unaudited / thin evidence |
| `--danger` | `#B4685E` | `#C87C71` | failed audit |

**Semantic colour rule.** Colour is never decorative here. Sage means *this is yours /
active*. Clay means *this is sourced* — it is the citation colour throughout, so evidence is
visually traceable at a glance. Amber means *not yet grounded*. Red means *audit failed*.
That mapping is the most distinctive thing about the UI and it falls directly out of D9.

**Typography.** One serif, one sans, one mono. Chapter bodies set in a serif (the volume is
prose meant to be read, not scanned); UI chrome in a system sans; identifiers and CLI output
in mono. Body 16px/1.65, measure capped at ~68ch. This serif/sans split is a deliberate
departure from both references, and it is what makes a volume feel like a *volume*.

**Form.** Radius 6px (8px on cards). Borders over shadows — at most one soft shadow, on
overlays only. Spacing on a 4px scale. Motion under 150ms, easing only, no bounce; respect
`prefers-reduced-motion`.

**Why.** Fixing this now means the SPA task is implementation, not design-by-subagent. The
semantic colour rule also does real work: it makes the chain of evidence legible in the
interface instead of buried in a data model.

**Cost.** Two typefaces to load. Both themes must be maintained from day one — cheaper now
than retrofitting dark mode later.

---

## D11 — Indexing: cheap scorer locates, tree expands

**Context.** Acceptance requires a "PageIndex-like-or-better strategy". The naive reading is
PageIndex's headline pitch: build an LLM-generated table-of-contents tree, then have an LLM
descend it from the root. Research into PageIndex's own production behaviour and its
competitors says that reading is wrong on both halves.

**What the evidence actually shows.**

1. **Strict top-down descent keeps losing, in three independent systems.** RAPTOR tested
   tree-traversal against collapsed search *over its own tree* and shipped collapsed.
   LazyGraphRAG ranks communities bottom-up by their best chunks' rank. And PageIndex's
   own documented production retrieval runs a cheap embedding value function *in parallel
   with* LLM tree search rather than relying on descent — it does not do the thing the pitch
   describes.
2. **Depth is a cost knob, not a quality knob.** GraphRAG's claim-based validation over
   47,075 extracted claims found *no statistically significant quality difference* between
   hierarchy levels whose token costs spanned 43×.
3. **The differentiator for hierarchical systems is economics, not retrieval accuracy.**
   LazyGraphRAG reaches comparable quality at a fraction of the cost with a *zero-LLM* index,
   which is the sharpest challenge to building an LLM-generated one at all.

**Decision.** Invert the usual pipeline. A cheap deterministic scorer does the **locating**;
the tree does the **expanding**.

```
1. LOCATE     BM25 over chapter text → scored candidate nodes
2. AGGREGATE  NodeScore(v) = 1/√(N+1) · Σ score(chunks under v), rolled up to volumes
3. EXPAND     hand the agent the ancestor closure of each hit: heading path,
              siblings, parent routing signals — structure around the hit
4. NAVIGATE   the agent reasons over that pruned tree (~1–3k tokens, not the whole index)
5. GRADE      sufficient | need-more(refined query) | not-in-corpus, ≤3 rounds
```

The `1/√(N+1)·Σ` aggregator is PageIndex's own published formula — it rewards nodes with
*many* relevant chunks with diminishing returns, where a plain mean would treat one hit and
ten hits identically. We adopt it directly with BM25 scores substituted for embeddings, which
also removes any need for an embedding API.

**Two further rules from the evidence:**
- **Route to the shallowest node that answers.** Depth costs tokens and buys no measured
  quality. Do not descend for its own sake.
- **Return passages in document order, not whole chapters.** CRAG's decompose-then-recompose
  was their single largest ablation: a mostly-irrelevant chapter can still contribute its one
  good paragraph.

**Decision — the index costs zero LLM calls.** Structure comes from Markdown headings.
Routing signals (`when_to_use`, `not_for`) come from chapter frontmatter, authored by Shadow
*at write time* as part of the skill-guided writing it is already doing. There is no separate
LLM indexing pass.

**Why this is defensible as "or better".** Our position is one no reference system occupies:
a free index, a traversal that costs nothing metered because it runs in the calling agent's
own context, and O(changed subtree) updates on edit. PageIndex spends LLM calls at both ends;
LazyGraphRAG spends at neither but gives up authored structure and provenance. We keep the
structure — which is what supplies bounds, citations, and operator intent — and pay for
neither end.

This works *because* we control authoring. Shadow writes the chapters, so routing signals are
a by-product of writing rather than something inferred afterwards from someone else's PDF.

**Honesty about the claim.** "Or better" is an economic argument, and it is currently a
hypothesis. T4.1/T4.2 exist to substantiate it: baseline first, then the comparison against
naive flat retrieval, measured on a golden set. If the numbers do not support it, this
decision gets revised rather than the criterion reinterpreted.

**Interaction with D9.** Authored routing signals are generated content and can therefore
hallucinate — `when_to_use` could promise something the chapter does not deliver, poisoning
retrieval while the prose beneath stays clean. The index-alignment check (D9, check 4) applies
to frontmatter, not just to summaries.

**Cost.** A BM25 implementation to own, and retrieval quality now depends on frontmatter
quality. The latter is a real risk and is exactly what T4.1's golden set must measure.

---

## D12 — The CLI is composable, and steers its caller in-band

**Context.** The CLI's consumer is a language model with a token budget, not a human.

**Decision.** Two design rules, both taken from measured results.

**Composable over rigid.** HuggingFace's open-Deep-Research scores 55% on GAIA with code
actions; switching the *same agent* to rigid JSON tool calls drops it to 33%, while also
taking ~30% more steps. So `shadow` is a real Unix citizen — pipeable, scriptable,
composable — rather than a single monolithic JSON endpoint. This is independent support for
the acceptance criteria's CLI-first framing over an MCP-only surface.

**In-band steering via `next_steps`.** PageIndex's MCP tools embed a `next_steps` block in
nearly every *tool result*, telling the calling agent what to do next. That is the right
place for it: we do not own the consuming agent's system prompt, but we do own our output.
`shadow` results carry a `next_steps` block, and errors carry one too. It is how the CLI
teaches an agent to use it without us controlling that agent.

**Cost.** A few tokens per result. Trivial against the cost of an agent taking a wrong turn.
