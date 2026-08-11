# Shadow

Shadow helps an operator distill their beliefs and experience into curated
**volumes** — indexed, chapter-based knowledge that agents can reason over.
The operator narrates a volume to Shadow (the shadow-writing chat agent),
which researches and writes chapters into it. The volume is then indexed and
made available to any agent via a CLI, so it can be discovered and used later
without being explicitly asked for. See `docs/ACCEPTANCE.md` for the full vision
and acceptance criteria.

The stack runs on the operator's own AI subscriptions rather than API keys.

## Packages

This is a Bun workspace monorepo with no build step — TypeScript runs
directly via Bun.

| package | purpose |
|---|---|
| `@shadow/core` | domain model and volume storage |
| `@shadow/model` | the single LLM seam; enforces subscription-only auth |
| `@shadow/indexing` | zero-LLM structural index and reasoning-based navigation |
| `@shadow/research` | tool-agents that fetch and snapshot sources |
| `@shadow/evidence` | chain of evidence — sources, claims, and the audit *(not yet implemented)* |
| `@shadow/agent` | Shadow, the user-facing chat agent |
| `@shadow/cli` | CLI used by agents to find and reason over volumes |
| `@shadow/api` | HTTP API |
| `@shadow/web` | operator-facing interface |
| `@shadow/evaluation` | evaluation harness |

## Documentation

| doc | what it is |
|---|---|
| [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) | the vision, critical path, and acceptance criteria |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | pillars, seams, and data flows |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | architectural decision record |
| [`docs/PLAN.md`](docs/PLAN.md) | working plan and task status |
| [`docs/INDEXING.md`](docs/INDEXING.md) | indexing schema and algorithms |
| [`docs/EVIDENCE.md`](docs/EVIDENCE.md) | chain-of-evidence schema, checks, and metrics |

## Getting started

Requires Bun 1.3.14+.

```sh
bun install
bun run check   # typecheck + lint + test
```

Individual checks:

```sh
bun run typecheck   # tsc across all packages
bun run lint         # oxlint, type-aware
bun run format       # biome format --write .
bun test              # bun test
```
