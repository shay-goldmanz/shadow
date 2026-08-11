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
