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

### D6a — Amendment: reuse requires persistence, and the fake must be able to fail

Shadow's sessions were created with `persistSession: false` while continuation was implemented
as `resume`. Those are mutually exclusive: the SDK's `resume` only works against a session
written to `~/.claude/projects/`, so **every second turn failed** with *"No conversation found
with session ID"*. Live-proven, twice.

The damage was wider than a second chat message. Shadow's research→draft continuation runs as
turn 2+ on the same handle, so the critical path's *"invokes tools and skills… adds 2
chapters"* could not complete through chat at all. D6 — the decision this project's entire
session-cost argument rests on — did not function.

**Amended:** sessions persist. `AgenticSession.close()` and `ShadowConversation.dispose()`
exist because persistence means on-disk transcripts that must be cleaned up, and the API binds
disposal to conversation eviction.

**Why 918 tests missed it, and the rule that follows.** `FakeAgenticSessionPort` could not fail
the way the real SDK does — a fake that only models the happy path will confirm any bug that
lives in the unhappy one. The fake now throws on a resumed non-persisted session, exactly as
the SDK does, and reintroducing the old flag makes the suite fail immediately.

**The general rule: a fake must be able to reproduce the failure modes of the thing it
replaces, or it is not a test double — it is an echo.** The same shape caused the web
interface to be built against a guessed wire contract that its own fake then confirmed.

**Known environment limitation.** The `SHADOW_LIVE_TEST=1` smoke tests currently fail under
`bun test` — but not under `bun run` — on Bun 1.3.14 with Agent SDK 0.3.226:
`TypeError: The "eventTargets" argument must be of type EventEmitter or EventTarget. Received
an instance of AbortSignal`, thrown inside the SDK's `setMaxListeners`. Live verification runs
via `bun run` until that combination changes.

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

### D10a — Amendment: the citation tone must be legible, not just quiet

Browser testing measured the rendered citation mark at **2.45:1 contrast in light mode**
(clay `#C08A72` on the `#F3E8E2` citation background; WCAG AA requires 4.5:1) at **9.33px**.
Dark mode passes at 6.39:1.

I wrote *"desaturated enough to sit under body text without competing"*, and the implementation
honoured that faithfully. But I over-specified quietness for the one element the whole design
is organized around: clay means *this is sourced*, and a reader who cannot comfortably read it
cannot trace evidence at a glance — which is the entire point of the semantic colour rule.
Quiet is a means; legible is the requirement.

**Amended:**
- Light-mode citation text darkens to **`#8A5A42`** against `--surface` / `#F3E8E2`, clearing
  4.5:1. Dark mode keeps `#CE9A83`, which already passes.
- `--clay` stays `#C08A72` for **non-text** uses (rules, borders, dot markers), where 3:1 for
  UI components applies and the softer tone still reads as the same family.
- Citation text never renders below **13px**, and never smaller than 0.85× the surrounding
  body size.

**Cost.** A slightly more assertive citation than I first pictured. The right trade: a
distinctive colour nobody can read is decoration, not signal.

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

### D11a — Amendment: at our scale the agent is the locator, not BM25

D11 above was written from evidence gathered at corpus scale, and it over-applied it. Sizing
the design against our actual numbers changes the default.

Our corpus is 1–20 volumes × 2–50 chapters × 300–3,000 words. A routing row
(`title` + `when_to_use` + `not_for` + `keywords`) is ~120 tokens, so the **entire chapter
index is ~12k tokens** — the calling agent can read all of it in one prompt. A hundred rows of
authored applicability statements is a *higher-signal, smaller* input than a hundred
BM25-scored chapter bodies. The crossover where a cheap scorer must locate first sits around
10M tokens; we are three orders of magnitude below it.

**Revised default:**

| Stage | At our scale |
|---|---|
| Locate | **Agent reads the full chapter index.** BM25 is not in the default path. |
| BM25 | **Fallback** when navigation returns nothing — it catches vocabulary the `when_to_use` fields miss (product names like "Linear" or "Epoch", error codes, people). |
| BM25 | **Disagreement signal** — if its top hit is far from the agent's pick, log it as a routing-quality alarm. |
| Promotion | BM25 becomes the primary locator past ~300 chapters. |

Everything else in D11 stands: the `1/√(N+1)·Σ` rollup (used whenever we do score), tree as
expander, shallowest-level routing, passages in document order, and the zero-LLM index.

**Why keep BM25 at all if it is off the default path.** It is ~150 lines with no dependencies
and no API key, and it earns its keep as the disagreement alarm — that signal is what tells
the operator a `when_to_use` is wrong, which is the feedback loop the whole design rests on.

**Lesson recorded.** Two of the four things I originally took from the research — Merkle
invalidation as a performance optimization, and the `merge_tree` cost model as a runtime
optimizer — were also corpus-scale machinery that buys nothing here. Full index rebuild on
every write takes milliseconds at 100 chapters. Hashes stay, but for citation staleness and
change detection, not for skipping work. The cost model stays too, inverted into a `shadow
lint` rule that tells the *operator* a chapter has grown too long to route into.

---

## D13 — Chapter identity is a ULID persisted in the file

**Context.** PageIndex's `node_id` is a DFS pre-order ordinal, so inserting a section
renumbers everything after it; its Markdown mode addresses nodes by line number, so any edit
above shifts every node below. Both are unusable for a corpus that is continuously edited —
and ours is edited by design.

**Decision.**

| Level | Identity | Stable across |
|---|---|---|
| Volume | directory slug | content edits, chapter add/remove |
| Chapter | **ULID, minted once by the indexer, written back into frontmatter** | rename, move, retitle, complete rewrite |
| Section | `<chapter ULID>#<slugified-heading-path>` | edits above and below, reflow, sibling changes |
| — | ~~line numbers, byte offsets, DFS ordinals~~ | nothing |

Byte offsets are derived at index time for fast reads and are **never** citation truth.
Resolution order across rebuilds: `id` → heading-path slug → `aliases` → `content_hash`
(catches a pure rename with unchanged body) → treat as new.

**Why.** The ULID lives *in the file*, so it survives everything short of deleting the file.
This is what makes a citation durable, and durable citations are what D9's chain of evidence
needs to still mean something after the operator edits a chapter.

**Cost.** The indexer mutates chapter files to mint IDs — a write during what looks like a
read-only operation. Deliberate and documented.

---

## D14 — Index self-critique is a first-class command

**Context.** Retrieval quality now rests on authored `when_to_use`/`not_for` fields (D11), so
bad frontmatter is the dominant failure mode. Measurement of PageIndex's own shipped trees
found generated summaries collapse into each other — 71% of nodes shared a page span with
another node, and 14 of 32 same-span pairs exceeded 0.90 summary similarity, several
byte-identical. Authored applicability statements resist this, but nothing guarantees it.

**Decision.** Ship `shadow lint` as a real command, run offline and never in the query path:

- **Discriminability** — flag sibling chapters whose `when_to_use` similarity exceeds 0.85.
- **Coverage / self-retrieval** — generate a plausible task per chapter and check the router
  returns that chapter. A chapter that cannot retrieve itself has a bad `when_to_use`.
- **Orphan detection** — chapters never returned by any probe.
- **Contradiction** — overlapping `when_to_use` with conflicting guidance, for the operator
  to reconcile or resolve with `supersedes`.
- **Miss log** — every `not-in-corpus` verdict appended to `misses.jsonl`.

**Why.** Self-retrieval is a routing evaluation that needs *zero labels* and, at ~100
chapters, costs ~100 cheap probes. It catches the dominant failure mode before it degrades
retrieval rather than after.

**The miss log is the point.** It is the operator's authoring backlog — it says which belief
to distill next, which is how Shadow closes its own loop instead of waiting to be asked.

**Cost.** One more command, and self-retrieval probes cost inference. Bounded and offline.

---

## D15 — Grounded is not the same as relevant, and D9's repair made it worse

**Context.** D9 defined the CoE Audit as four grounding checks. Research into production
groundedness systems shows that grounding is only one of *two* axes, and a system measuring
one while optimizing against it will drift.

The argument, from Bedrock Guardrails' worked example:

> Source: *"London is the capital of UK. Tokyo is the capital of Japan."*
> Query: *"What is the capital of Japan?"*
> - *"The capital of Japan is London"* → relevant, ungrounded
> - *"The capital of UK is London"* → **grounded, true, and irrelevant**

Azure names the split cleanly: **groundedness is precision** (contains nothing outside the
source), **completeness is recall** (misses nothing critical).

**The flaw this exposes in D9.** Every check in D9 measures grounding only. So a Shadow
chapter can pass the entire audit while drifting off the subject the operator actually asked
about — and D9's repair rule makes this *more* likely, not less. "Restate conservatively
against the source" is precisely the move that converts a slightly-unsupported claim into a
well-cited answer to a question nobody asked. I built a repair loop that optimizes the metric
I was measuring, in the direction of the failure I was not.

**Decision.** Add a fifth check — **C5, chapter relevance**: does each claim serve the
chapter's stated subject and its `when_to_use`? It is non-blocking, surfaced as a warning
rather than a failure, and batched into the same judge session as the entailment check so it
costs almost nothing extra.

**Why non-blocking.** Relevance is a judgment call about the operator's intent, and the
operator is the authority on that. The audit's job is to *show* them drift, not to overrule
them. Blocking on grounding is right — fabrication is never what they wanted. Blocking on
relevance would be the tool second-guessing the author.

**Cost.** One more dimension in an already-open judge call. Effectively free.

---

## D16 — Content drift, not link rot, is the failure mode worth detecting

**Context.** D9 has research tool-agents snapshot every source and hash it, so citations can
be verified later. The obvious implementation — one hash over the fetched bytes — turns out to
be close to useless.

Klein et al. (*PLOS ONE*, doi:10.1371/journal.pone.0167475) measured that **content drift
affects roughly 3 in 4 URI references**, against about 1 in 5 for outright reference rot. The
page usually still resolves; it just no longer says what was cited. A citation checker that
tests for HTTP 200 is measuring the wrong thing.

And a single hash over raw bytes is worse than nothing here: it churns on every ad rotation,
session token, and rendered timestamp, so it fires constantly and gets ignored.

**Decision.** Two digests per snapshot, with distinct jobs:

| Digest | Over | Job |
|---|---|---|
| `payload_sha256` | raw fetched bytes | exact-reproduction identity; never used for alerting |
| `normalized_text_sha256` | after boilerplate strip, NFC normalization, whitespace collapse | **the re-verification trigger** — changes only when the prose changes |

Only the normalized digest raises a staleness alarm. This split is not novel — WARC already
distinguishes `WARC-Block-Digest` from `WARC-Payload-Digest` for the same reason.

**Also adopted, because they are standards rather than inventions:**
- **W3C Web Annotation selectors** for evidence spans: a `TextQuoteSelector` (`exact`,
  `prefix`, `suffix`) as durable identity, with a `TextPositionSelector` nested under
  `refinedBy` as the fast-but-fragile hint. Durable outer, brittle inner, one object.
- **Robust Links** (`data-originalurl`, `data-versionurl`, `data-versiondate`) on rendered
  citations, so a reader can reach the snapshot, revisit the original, or find a temporally
  near capture if the snapshot itself dies.
- **RFC 6920 `ni:` URIs** so snapshot identifiers are self-describing rather than opaque.
- **Character offsets, not byte offsets**, for evidence spans, documented explicitly.
  Providers disagree — Gemini/Vertex use bytes, Anthropic and OpenAI use characters — and the
  mismatch silently mis-aligns non-ASCII text. Note this differs from `docs/INDEXING.md`,
  which uses byte spans into *our own* Markdown files; that is a separate concern and stays
  as it is.

**Anchoring outcome is itself recorded.** Whether a citation resolved cleanly, resolved
fuzzily (with distance), or **orphaned** goes into the ledger. Hypothesis treats orphaning as
a first-class state that is shown rather than hidden, and that is right: "this citation still
resolves" is a claim that decays, so it needs a recorded value rather than an assumption. If
the cited text is deleted outright, no algorithm recovers it — say so plainly.

**Cost.** Two hashes and a normalization pass per snapshot. Trivial next to the fetch.

**Caveat carried forward.** Specific fuzzy-matching constants (context length, score weights,
timeouts) could not be verified against primary sources. They ship as tunable configuration
with documented defaults, not as received wisdom.

---

## D17 — The evaluation reports what it could not judge

**Context.** T4.1 establishes a measured retrieval baseline against a golden set.

**Decision.** Every evaluation run also reports **`holes_ratio`** — the fraction of retrieved
items for which the golden set holds no relevance judgment.

**Why.** Without it, a golden set silently drifts into scoring only the slice it already has
labels for, and the resulting number looks like coverage when it is selection. Azure's
retrieval evaluator emits exactly this and almost nobody tracks it. Given that D11a's whole
"or better" claim rests on measurement, the honest bound on that measurement has to travel
with it.

**Cost.** One more number. It will sometimes be embarrassing, which is the point.

---

## D18 — A claim is a sentence, marked with a Markdown footnote

**Context.** D9 requires every claim to carry an evidence chain, which forces two questions:
what is a claim, and how is it marked in a file the operator has to read and edit.

**Decision.** A claim is **a sentence, as written** — not a proposition extracted from it.
Claims are marked with ordinary Markdown reference footnotes (`[^lin-4px]`), with all
machine-facing data in a sidecar JSON file beside the chapter.

**Why sentences.** Decomposition granularity is the largest source of variance in this entire
field: identical text and identical verifier but a different decomposition strategy moves
scores 33.00 → 61.51, flipping 19% of judgments. It is also trivially gameable — padding with
obvious subclaims inflates precision, and under attack FActScore drops 83.0 → 36.2. **If we
never decompose, none of that can happen to us.** The sentence is also the unit the operator
edits, and D4 exists precisely so they can edit.

**Why footnotes over the alternatives.** An invisible sidecar anchored by quoting the sentence
would leave the operator unable to see which sentences are grounded — and worse, any edit
silently orphans the claim, making "operator rephrased this" indistinguishable from "operator
wrote something new and unsourced." Custom inline markers (`{{claim:clm_01HQ8ZK}}`) render as
garbage and put a ULID in prose a human must read. Footnotes are valid Markdown, render as
citations, and are idiomatic.

**The load-bearing property** is that the label is a short, stable, human-chosen string the
operator keeps while rewriting the sentence around it. That is what tells us "same claim,
restated" with certainty instead of by inference.

**Cost.** A sentence carrying two propositions where only one is supported gets a single
verdict. That is what `partial` is for — and `partial` is the lowest-agreement label in every
published scheme, so it is where our judge will be weakest. Accepted; the alternative is worse.

---

## D19 — The writer does not decide what needs evidence

**Context.** Not every sentence is an empirical claim. Connective prose, the operator's stated
preferences, and definitional statements exist. Requiring evidence for all of it is both wrong
and expensive — but any exemption rule the writer controls becomes a loophole that swallows
the rule.

**Decision.** The writer marks what it cites. A **separate auditor pass independently
classifies every unmarked sentence** as check-required or not. Disagreement is a failure, not
a negotiation: a sentence the auditor says needed a chain and the writer left unmarked is an
orphan claim, and the chapter fails.

**Silence is what gets audited.** That is the structural reason the writer cannot exempt itself.

Four claim kinds, three of which require something:

| kind | Requires |
|---|---|
| `sourced` | ≥1 evidence span that entails it |
| `derived` | ≥1 supporting claim in the same chapter, and no scope beyond them |
| `operator` | **a citation into the session turn where the operator actually said it** |
| `narrative` | nothing |

**`operator` is the decision that matters most here.** Shadow's whole product is distilling
the operator's beliefs, so a category for "this is what they think" is unavoidable — but
free-form, it licenses writing anything and calling it belief. So operator claims cite the
chat transcript, stored as a source like any other with `transport: "session"` and verified at
Tier 0 by exact quote match. **Shadow cannot mint a belief the operator never expressed, for
the same structural reason it cannot mint a citation to a page it never fetched.** This
extends D9's guardrail: the transcript is the second and only other legitimate origin of a
source record.

`narrative` is bounded by form-based exclusion, the auditor sweep, and a **visible budget** —
`narrativeRatio` is reported per chapter. Classification need not be perfect; abuse only has
to be visible.

**One subtle rule with outsized effect:** `checkRequired: false` sentences are excluded from
**both** numerator and denominator of every groundedness metric. Collapsing "not check-worthy"
into "unsupported" is the most damaging labelling error in this space — do it and every
well-written chapter, the ones with topic sentences and transitions, scores as ungrounded,
pushing Shadow toward stilted citation-stuffed prose.

**Cost.** An extra classification pass over unmarked sentences. Batched into the existing
judge session, and only over sentences that are new or changed.

---

## D20 — Three cost tiers, memoized on an input hash

**Context.** D6 says a fresh model session costs ~18k cache-write tokens. An audit that
re-judged every claim on every edit would be unusable.

**Decision.** Tier 0 is pure code and runs always, including in every offline test. Tier 2 is
a single batched LLM judge session that runs **only over claims whose verification inputs
changed**, keyed on
`inputHash = sha256(decontextualized ‖ evidence spans ‖ snapshot hash ‖ supports)`.

Tier 1 — a small local entailment model as a cheap pre-filter — is **deliberately deferred**,
because it would introduce a non-subscription model dependency that cuts against D5. It is the
lever to pull if judge cost becomes a problem.

**Why this matters beyond cost.** The tier split means **the entire completeness property and
the entire anti-fabrication property live in Tier 0** — structural checks, span resolution
against stored snapshots, and exact-quote verification of operator claims. All of it is
testable in `bun test` with no network and no model. The expensive, fuzzy, model-dependent
part is only the *semantic* judgment of whether a span entails a claim.

**Cost.** Rewriting prose without changing a claim or its evidence re-runs nothing; a typical
edit judges 1–5 claims. The expensive case is the first full audit of a new chapter, once.

---

## D21 — Guardrails against optimizing the audit into uselessness

**Context.** D9's repair rule restates unsupported claims conservatively against their source.
D15 already found that this pushes toward irrelevance. There are two further ways a naive
repair loop degrades the product while improving its metrics.

**Decision.** Two guardrails, both measured.

**1. Preservation bound.** RARR states the attack plainly: *"an adversarial editor could
ensure 100% attribution by simply replacing the input with the text of any arbitrary retrieved
document, which is trivially attributable to itself."* Reject any restatement whose Levenshtein
distance from the original exceeds `max(80 chars, 0.5 × original length)` and escalate to the
operator. Log the distance either way. The published comparison is stark: one system scored
*higher* raw attribution while destroying intent (preservation 16.0 vs 90.0; combined F1 17.1
vs 57.0).

**2. Extractiveness as a watched metric, never a target.** Track mean longest-common-substring
between a claim and its cited span. Citation precision and *perceived utility* correlate at
**r ≈ −0.96** across production generative search engines — the system with the highest
citation precision had the lowest utility, because heavily-grounded statements trend toward
near-verbatim copying. Vectara say the same of their own leaderboard: a copy-paste summarizer
scores 0% hallucination.

**The rule to internalize:** if Shadow's volumes get more grounded and less useful, the metric
is working and the product is failing. Extractiveness rising alongside groundedness is that
signal, and it is why extractiveness is reported next to every groundedness number rather than
buried.

**Cost.** Two cheap computations and one metric that exists to make us uncomfortable.

---

## D22 — Orphan semantics: fabrication blocks, drift warns

**Context.** The Wave 1 review found `docs/EVIDENCE.md` contradicting itself. C2 says *"every
`selector.exact` **resolves** in its pinned snapshot"* and treats failure as blocking. D16 says
*"**Orphan is a state, not an error.** It renders as a warning, never a failure."* The
implementation had to pick, and picked blocking — meaning a source drifting under a published
chapter fails that chapter's next audit outright, which is exactly the aging-corpus failure
D16 wanted surfaced rather than fatal.

**The contradiction was mine, and both halves were right about different things.** Resolving:

| Situation | Verdict | Why |
|---|---|---|
| `selector.exact` does not resolve **in the pinned snapshot** | **Blocking failure** | Snapshots are immutable and content-addressed. If the quote is not in the exact bytes we stored, the citation was fabricated or the snapshot was tampered with. Neither is survivable. |
| The **live source has drifted** — `normalizedTextSha256` no longer matches | **Warning**, claim marked stale, refetch queued | The operator did nothing wrong and the world moved. Failing here would make every published volume rot into failure over time. |

**Why this is the right cut.** Pinning is what makes the distinction possible: because the
cited snapshot never changes, an unresolvable selector against it can only mean fabrication or
corruption. Drift is a separate, expected fact about the world, detected by a different
mechanism (D16's normalized digest) and carrying different weight.

**Cost.** Two distinct code paths where the implementation had one.

---

## D23 — Source records cannot be minted, only witnessed

**Context.** `ARCHITECTURE.md` promises fabricated citations are *"structurally impossible
rather than merely discouraged"*, and D9 says research tool-agents are the only code permitted
to originate a source record. The review found this is currently **convention, not structure**:
`EvidenceStore.putSource` is public API taking a fully-formed record, on a package
`@shadow/agent` will also depend on. Any caller can mint a record claiming
`transport: "live"` with a self-consistent snapshot, and the integrity check passes — because
it verifies *self-consistency*, not *provenance*.

The review found the same family of hole in D19's operator claims: nothing verified that an
`operator` claim's cited source was actually a session transcript, so Shadow could point a
"the operator said this" claim at any fetched web page containing the sentence.

**Decision.** Origination takes a **witness**, not a record. `putSource` accepts either a
`FetchedPage` produced by `@shadow/research`'s transport, or a session-transcript handle — and
derives the source record itself. There is no public path that accepts a hand-assembled
`SourceRecord`.

And `transport` becomes load-bearing rather than descriptive: operator-claim verification must
resolve the cited source and require `transport === "session"`.

**Why.** A guarantee that depends on every caller behaving is not a guarantee. The whole
argument for this design is that Shadow *cannot* fabricate, and that has to be enforced by the
type system and the API shape, not by the writer's good manners. Making the two legitimate
origins — a real retrieval and a real transcript — the only constructors is what makes the
claim true.

**Cost.** A narrower, slightly less convenient API, and research and evidence become more
tightly coupled at exactly one point. Worth it.

---

## D24 — Integrity resolution is exact-only; fuzzy anchoring is for drift alone

**Context.** The Wave 2 review demonstrated, by execution, that a **fabricated claim passes the
entire audit**. A snapshot saying *"standardized every sidebar measurement on an 8 px grid"*,
cited by a claim whose `selector.exact` says *"4 px"* (edit distance 2), produced: C2 passed
with only an `anchored-fuzzy` warning, the numeric sub-check validated the claim's "4" against
the fabricated quote's own "4", and C3 judged entailment against the fabricated string. Every
blocking check green, on a claim its own source contradicts.

**The cause is a contradiction I left in the spec.** D22 says *"if the quote is not in the
exact bytes we stored, the citation was fabricated or the snapshot was tampered with"* — while
`EVIDENCE.md`'s resolution algorithm offers a fuzzy step, and C2 used it. But fuzzy resolution
is only ever *coherent* against text that has drifted. A snapshot is immutable and
content-addressed: there is no legitimate way for a quote to be nearly-but-not-quite present in
it. The cooperative write path already requires an exact `indexOf` at bind time, so
fuzzy-in-a-pinned-snapshot has exactly one cause — fabrication.

**Decision, two parts:**

1. **C2 resolves exact-only.** Fuzzy anchoring applies solely to re-anchoring against
   *refetched* text on the drift path. An unresolvable quote in a pinned snapshot blocks, per
   D22, with no fuzzy escape hatch.
2. **The judge sees stored bytes, never writer-supplied text.** C3 and the numeric sub-check
   must consume the **resolved snapshot slice**, not `selector.exact`. Today they read the
   claim's own copy of the quote, so a fabricated quote is checked against itself — the check
   is circular and cannot fail.

Either part alone closes the hole. Both together make it structural: there is no path by which
text that is not in the store reaches a judge.

**Why this is the most important correction in the project so far.** The entire chain of
evidence rests on one claim — *Shadow cannot write what it cannot cite*. A circular check
makes that claim decorative. The lesson generalizes: **a verifier must never be handed the
thing it is verifying**, and I specified exactly that without noticing.

**Cost.** Slightly stricter authoring: a quote must match the snapshot byte-for-byte. That is
the point.

---

## D25 — Everything claim-bearing is audited, including list items

**Context.** The review found that unmarked prose inside list items and blockquotes is excluded
from sentence segmentation entirely, so a hallucinated bullet — `- Linear caps row height at
32px` — is invisible to C1b's check-worthiness sweep, invisible to C1a (no marker), and
**never enters `narrativeRatio`'s numerator or denominator**.

That last part is what makes it serious. D19's defense was never perfect classification; it was
that *abuse is visible*. Here it is not visible: the exemption budget cannot see the exempted
text. And design-guidance chapters — the genre Shadow exists to write — are the most
bullet-heavy prose there is.

**Decision.** `EVIDENCE.md` authorized excluding list *scaffolding*; the implementation excluded
list *content*. Only the marker (`- `, `1. `) is scaffolding. List-item text is segmented and
swept like any other prose. Anything still excluded must at minimum count toward the narrative
budget, so the exemption stays visible.

**Cost.** More sentences to classify per chapter, batched into the existing judge call.

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

---

## D26 — Model access is a provider strategy

**Context.** D5's acceptance criterion is absolute: *"The entire stack runs on the
operator's AI subscriptions, NOT on api keys."* That criterion was true unconditionally,
because `@shadow/model` had exactly one way to build its two ports — the claude-code
adapters, subscription-only by construction. Some operators run in AWS-governed
environments where the constraint is inverted: model access must go through AWS Bedrock,
authenticated with the account's standing AWS credentials, not a Claude subscription.
Bedrock also removes the per-call `claude` CLI subprocess both existing adapters spawn.

**Decision.** D5's subscription-only rule becomes the *default* strategy, not the *only*
one. `@shadow/model` gains a second provider strategy, `bedrock`, behind the same two ports
(`StructuredGenerationPort`, `AgenticSessionPort`) the claude-code strategy already
implements — callers never see which strategy is in play. `bedrock` authenticates via the
standard AWS credential chain: our code never reads or handles `ANTHROPIC_*` (or any AWS key
material) itself, exactly as it never read `ANTHROPIC_API_KEY` under D5 — the AWS SDK
resolves credentials, we just hand it the call.

Selection is explicit configuration, never a fallback: an operator sets
`SHADOW_MODEL_PROVIDER=bedrock` to opt in. A missing or unrecognized value resolves to
`claude-code` — `bedrock` is only ever entered deliberately, never landed on by omission or
typo. `@shadow/model`'s public factory (`createModel`) takes a `provider` field for exactly
this; `@shadow/api`'s composition root reads the env var and passes it through.

The claude-code strategy's guardrail (`assertSubscriptionAuth`, `guardrail.ts`) is untouched
and still fails closed the moment that strategy's auth resolves to anything but the
subscription — D5's acceptance criterion still holds *for that strategy*. It says nothing
about a strategy an operator explicitly opted out of it for.

**Why.** Some operators cannot or do not want a Claude subscription driving production
traffic — Bedrock is how they stay on AWS-native billing, IAM, and network boundaries. As a
second-order benefit, Bedrock calls the model API directly rather than shelling out to a
CLI subprocess per call, cutting fixed per-call overhead the claude-code adapters pay.

**Cost.** A discriminated-union config surface instead of a single implicit path, and a
second SDK (`@ai-sdk/amazon-bedrock`) to keep compatible. Contained at the same one seam D5
already established: no caller outside `@shadow/model` imports an AI SDK, Bedrock's
included.

**Guardrail.** `packages/agent/src/no-direct-fetch.test.ts` — D5's structural "only
`@shadow/model` touches an AI SDK" guard — lists `@ai-sdk/amazon-bedrock` as forbidden
alongside the existing two SDKs, before the dependency even enters the tree.
