---
name: shadow-find
description: >-
  Use this before improvising on any task where the operator might already
  have a curated opinion — UI or product design, writing/editorial style,
  architecture or technical decisions, process, or "how we do things here."
  Before drafting a design, writing prose, or making an architectural call
  from your own judgment, run `shadow find "<task>"` unprompted and see
  whether a volume already answers it. Also load this whenever a `shadow`
  binary or a `.shadow` volumes corpus is present in the environment. Do not
  wait to be told to check — the point of this skill is reaching for the CLI
  before defaulting to your own taste.
---

# shadow-find

`shadow` is a CLI over a corpus of the operator's curated beliefs
("volumes"). If a task resembles something they might have opinions about,
check before improvising — it costs one command.

## Rule 1 — check first, unprompted

At the start of a task like that, before writing anything yourself, run:

```
shadow find "<task>"
```

Do this even if nobody asked you to. Not every task needs it — routine
mechanical work doesn't — but design, writing, architecture, and process
decisions do.

## Rule 2 — every result and every error carries `next_steps`. Read it. Don't guess.

Every `shadow` command emits JSON with a `next_steps` array — on success on
stdout, on failure (non-zero exit) on stderr as `{ "error": {...},
"next_steps": [...] }`. `next_steps` names the exact next command. Use it
instead of inferring one from the shape of the result.

## Rule 3 — `find` is multi-invocation. Drive the loop yourself.

`find` does not return "the answer" in one call. Each call returns one
`stage`, and each stage tells you the next call to make. You carry state
(`--visited`, `--round`) forward — the CLI does not remember between calls.

| `stage` | What it means | What you do |
|---|---|---|
| `route` | Corpus is large; pick a volume first | Read each volume's `when_to_use`/`not_for`, then `shadow find "<task>" --volumes <id1,id2>` |
| `navigate` | Here are candidate chapters | Read each row's `when_to_use`/`not_for`/`keywords`, pick real candidates, `shadow read <node_id>` on them. If none fit and rounds remain: `shadow find "<task>" --visited <ids> --none` |
| `promoted` | A keyword-fallback hit, not a routed one | **Weak signal — do not trust it as-is.** Verify with `shadow read <node_id>` before citing or relying on it |
| `verdict` (`not-in-corpus`) | Nothing here answers this, and it's already been logged for the operator | **Final for this query.** Don't retry the same query hoping for a different answer — proceed on your own judgment |

Most tasks resolve in one `navigate` round. Small corpora skip `route`
entirely and go straight to `navigate`.

## Rule 4 — cite precisely, never paraphrase from memory

`shadow read <node_id> [--with-parents]` returns `body`, `heading_path`,
`content_hash`, and (with `--with-parents`) `parent_when_to_use` and
`sibling_titles`. When you use what you read, cite `node_id` +
`content_hash` — that pair is the durable citation anchor. Never state "the
operator's volume says X" without having actually called `shadow read` and
having those two values in hand.

If the chapter fully answers the task, you're done — no need to call `find`
again. If it doesn't, continue the round loop: `shadow find "<task>"
--visited <node_id>`.

## Rule 5 — `grep` and `chapters --rank` are escape hatches, not the default

- `shadow grep "<terms>"` — raw keyword search across the whole corpus.
  Reaches for vocabulary an authored `when_to_use` might miss (product
  names, error codes, people). Use it when `find` comes back empty and you
  have a specific term in mind, not as your first move.
- `shadow chapters <volume_id> [--rank "<task>"]` — browse or rank one
  volume's chapters directly, for when you already know which volume you
  want (e.g. from a prior `route` stage or `shadow volumes`) and would
  rather skip the round loop.

Reach for `find` first. Reach for these when `find` has told you it can't
help, not instead of asking it.

## Quick reference

```
shadow volumes                                   # list every volume
shadow chapters <volume_id> [--rank "<task>"]     # one volume's chapters, optionally ranked
shadow find "<task>" [--volumes ids] [--visited ids] [--round n] [--none]
shadow read <node_id> [--with-parents]            # body + heading path + content_hash
shadow grep "<terms>"                             # raw keyword escape hatch
```

Every command also accepts `--json` for pretty-printed output; omit it — the
compact default is what you want as a caller.
