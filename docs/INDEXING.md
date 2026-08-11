# Indexing specification

Implementation spec for `@shadow/indexing`. Decisions and rationale live in `DECISIONS.md`
(D11, D11a, D13, D14); this document is the contract to build against.

**Core property: the index build makes zero LLM calls, zero network calls, and needs no API
key.** Structure comes from Markdown headings; routing signals come from frontmatter authored
by Shadow at write time.

## Scale we are designing for

1–20 volumes × 2–50 chapters × 300–3,000 words. Realistically ~100 chapters, ~150k tokens of
body, and a **~12k-token complete chapter index**. Every sizing choice below follows from
these numbers — see D11a before "optimizing" anything.

## Chapter frontmatter — the source of truth

```yaml
---
id: 01J8X7QK3M2F5R7T9V0W1Y2Z3A       # ULID, minted once by the indexer, never changes
title: How Linear handles information density
when_to_use: >
  Designing list views, tables, dashboards — any screen with many rows.
  Choosing between density and whitespace. Deciding what metadata belongs
  inline versus revealed on hover.
not_for: marketing pages, onboarding flows, empty states, mobile-first layouts
keywords: [density, list view, table, row height, hover, Linear]
confidence: high                      # high | medium | provisional
supersedes: [01J8A2QK3M2F5R7T9V0W1Y2Z3B]
aliases: [ui-row-density]             # former slugs, for citation resolution
updated: 2026-08-11
---
```

`when_to_use` describes **when the chapter applies**, not what it says. That distinction is
the whole design: a summary describes content, and generated summaries measurably collapse
into each other; applicability statements stay discriminable. `not_for` carries negative
signal that no summary provides and no embedding can represent.

`when_to_use` must describe the **whole chapter**, not its opening paragraphs. Enforced in the
writing skill.

Volumes carry the same routing fields in `VOLUME.md`.

## `index.json` — derived, regenerated wholesale

```jsonc
{
  "schema_version": 1,
  "generated_at": "2026-08-11T10:47:00Z",
  "corpus_hash": "sha256:e31a…",
  "stats": { "volumes": 3, "chapters": 47, "tokens": 61240 },

  "volumes": [{
    "volume_id": "ui-design",
    "title": "Interface Design",
    "when_to_use": "Designing UI: layout, density, navigation, component behavior.",
    "not_for": "brand identity, illustration, motion design",
    "keywords": ["linear", "notion", "density"],
    "chapter_count": 12,
    "volume_hash": "sha256:7c02…",

    "chapters": [{
      "node_id": "01J8X7QK3M2F5R7T9V0W1Y2Z3A",
      "kind": "chapter",
      "title": "How Linear handles information density",
      "slug": "linear-ui-density",
      "path": ["Interface Design", "How Linear handles information density"],
      "file": "volumes/ui-design/chapters/linear-ui-density.md",

      "when_to_use": "Designing list views, tables, dashboards …",
      "not_for": "marketing pages, onboarding flows, empty states",
      "keywords": ["density", "list view", "row height", "Linear"],
      "confidence": "high",
      "supersedes": ["01J8A2QK3M2F5R7T9V0W1Y2Z3B"],
      "aliases": ["ui-row-density"],

      "updated": "2026-08-11",
      "tokens": 1452,
      "span": { "start_byte": 612, "end_byte": 7315 },  // body only, excludes frontmatter
      "content_hash": "sha256:9f2c…",   // own text, EXCLUDING descendants
      "subtree_hash": "sha256:1a7e…",   // content_hash || concat(child subtree_hashes)

      "sections": [{
        "node_id": "01J8X7QK3M2F5R7T9V0W1Y2Z3A#density-vs-whitespace",
        "kind": "section",
        "title": "Density vs whitespace",
        "level": 2,
        "heading_path": ["Density vs whitespace"],
        "span": { "start_byte": 640, "end_byte": 2140 },
        "tokens": 318,
        "content_hash": "sha256:c4b1…",
        "subtree_hash": "sha256:c4b1…",
        "key_items": ["Row height", "Truncation rules"]  // headings merged away
        // No `summary`. No `when_to_use`. Sections bound and cite; they do not route.
      }]
    }]
  }]
}
```

### Schema invariants — assert these in tests

**Amendments from implementation (T2.2).** Three details in this document were
under-specified and were resolved during the build; the resolutions are better than the
original text and are now normative:

1. **Spans are offsets into `Chapter.body`, not the whole file.** The pseudocode implies
   whole-file offsets via `body_offset`, but `@shadow/core` never exposes raw file bytes —
   only the parsed body. Body-relative offsets are also what any consumer actually slices
   against, through the same store.
2. **`end_byte` is exclusive (half-open `[start, end)`)**, not "next start minus 1". Required
   for consistency with a chapter's own `[0, EOF)` span.
3. **`when_to_use` / `not_for` accept either a YAML string or a string array**, arrays joined
   with `"; "`. Both forms occur naturally in authored frontmatter.

| Question | Answer |
|---|---|
| How does a node address into a chapter? | `file` + `span: {start_byte, end_byte}` — body-relative, half-open, derived at index time |
| What is the citation anchor? | `node_id` + `content_hash` (+ `path` for humans) |
| Are spans overlapping? | **No.** A section ends one byte before the next heading of level ≤ its own. Markdown headings are unambiguous — we have no PDF page-boundary problem, so do not inherit PageIndex's deliberate 1-page overlap. |
| Does a parent's span cover its subtree? | **Yes — union semantics.** `chapter.span` covers the whole body. PageIndex ships *both* conventions and it is a live footgun; pick one and assert `parent.span ⊇ ∪ children.span`. |
| Do sections route? | No. Only volumes and chapters carry `when_to_use`. |
| Do any nodes get generated summaries? | **No.** |

## Algorithm: build

```
build_index(root) -> index.json

1. DISCOVER  volumes = dirs under root/volumes/* containing VOLUME.md

2. For each volume, sorted by slug:
   a. parse VOLUME.md frontmatter -> volume routing row
   b. for each chapters/*.md, sorted:

      i.   split frontmatter (YAML between the first two `---` fences at byte 0)
      ii.  if no `id`: mint ULID and REWRITE the file with it   <- deliberate side effect
      iii. body = bytes after the closing fence; body_offset = that index
      iv.  EXTRACT HEADING TREE from body:
             regex ^(#{2,6})\s+(.+)$        // `#` level 1 is the title, not a section
             skip headings inside fenced code blocks (``` and ~~~)
             slugify: lowercase, non-alnum -> '-', collapse, trim
             duplicate sibling slugs get -2, -3, …
             nest with a level stack:
               while stack and stack[-1].level >= level: stack.pop()
               parent = stack[-1] or chapter; stack.push(node)
      v.   ASSIGN SPANS, non-overlapping:
             start = body_offset + byte index of the heading line
             end   = start of next heading with level <= this level, minus 1
                     (or chapter end)
             chapter.span = [body_offset, EOF]        // union semantics
      vi.  SECTION THRESHOLD:
             if chapter.tokens < 800:
               drop `sections`; keep heading titles as chapter.key_items
      vii. HASH, post-order:
             own_text(v)    = bytes in v.span not covered by any child
             content_hash   = sha256(normalize(own_text(v)))
             subtree_hash   = sha256(content_hash || concat(child subtree_hashes))
           normalize = strip per-line trailing whitespace, collapse blank runs, LF endings
           (so reformatting does not churn hashes)

   c. volume_hash = sha256(concat(chapter subtree_hashes, slug order))

3. corpus_hash = sha256(concat(volume_hashes, slug order))

4. BM25 (built, but off the default query path — see D11a):
     fielded, unit = chapter (and section where sections exist)
     title ×3, when_to_use ×3, keywords ×3, body ×1
     standard k1=1.2, b=0.75

5. WRITE atomically: index.json.tmp -> fsync -> rename
```

At ~100 chapters this runs in well under a second. **Rebuild wholesale on every write** — do
not build incremental machinery to skip work that takes milliseconds.

## Algorithm: update on edit

Hashes exist for **citation staleness and change detection**, not for skipping work.
Complexity is O(changed chapter) + O(#chapters in volume) + O(#volumes); the last two terms
are integer hash concatenation over ≤50 and ≤20 items.

| Change | Invalidates |
|---|---|
| Chapter body edit | its hashes → volume → corpus; its BM25 postings; **all outstanding citations** (hash mismatch) |
| Section body edit | that section → ancestor chain → chapter → volume → corpus |
| `when_to_use`/`not_for`/`keywords` edit | routing row + BM25 field postings **only**. Body hashes and citations unaffected — this is why they are separate fields. |
| Heading retitled | that section's `node_id`. Push the old slug to `aliases`. |
| Chapter renamed or moved | `file` path only. **ULID unchanged, citations unaffected.** |
| Chapter added or deleted | `volume_hash`, `corpus_hash`, slug→id map |

Append every change to a changelog so agents can ask what they missed.

## Algorithm: retrieval

Stages 2, 3 and 5 are the **calling agent's own inference**, not LLM calls inside the CLI.
The CLI ships JSON; the agent reasons. This is what keeps the stack on the operator's
subscription with no API key anywhere.

```
shadow find "<task>" [--rounds 3] [--json]

STAGE 0  LOCATE (fallback only at our scale)
         BM25 over chapters/sections, fielded

STAGE 1  ROLLUP (only when scoring)
         NodeScore(v) = 1/sqrt(N_v + 1) * Σ score(units under v)
         applied identically at chapter level (N = sections)
                            and volume level  (N = chapters)

STAGE 2  ROUTE                                   [agent inference]
         if total_chapters <= 60: emit the full chapter index, skip to STAGE 3
         else: emit the volume manifest (≤150 tok/volume), agent picks volume_ids

STAGE 3  NAVIGATE                                [agent inference]
         emit chapter rows: {node_id, title, when_to_use, not_for, keywords,
                             tokens, updated, confidence, superseded_by?}
         agent returns node_ids + reasoning + rejections WITH REASONS

STAGE 4  EXPAND & READ                           [0 LLM calls]
         ancestor closure of hit set H:
           keep = H ∪ ancestors(H) ∪ immediate siblings
         render the pruned tree as an INDENTED OUTLINE, not JSON (~3× cheaper),
         keeping node_id on every row
         shadow read <node_id> [--with-parents]
           -> body bytes from span, heading path, parent's when_to_use,
              sibling titles, content_hash

STAGE 5  GRADE                                   [agent inference]
         verdict ∈ { sufficient | need-more(<refined query>) | not-in-corpus }
         if need-more and round < 3: goto STAGE 3 carrying visited[] + refinement
         if not-in-corpus: append to misses.jsonl and return the explicit verdict
         emit the trace with hash-pinned citations
```

Rules that carry real weight:

- **Never put body text in a structure payload.** The index the agent reads carries no bodies.
- **Return passages in document order** where sections exist, not whole chapters. A mostly
  irrelevant chapter can still contribute its one good section.
- **Route to the shallowest node that answers.** Depth costs tokens and buys no measured
  quality.
- **Carry `visited[]` forward** across rounds so the agent does not reselect a chapter.
- **Record rejections with reasons** — that is the operator's signal to fix a `not_for`.
- Bound at **3 rounds**. Most queries resolve in one.

## The retrieval trace

```jsonc
{
  "query": "design a one-pager",
  "rounds": 1,
  "trace": [
    { "step": "route", "considered": ["ui-design", "writing"], "chose": ["writing"],
      "why": "one-pagers are a document format; Epoch expertise sits in writing" },
    { "step": "navigate", "volume": "writing",
      "chose": ["01J8Q2VX7K9M3P5R8T0W2Y4Z6B"],
      "rejected": [{ "node_id": "01J8Q3…", "why": "not_for lists short-form" }] },
    { "step": "grade", "verdict": "sufficient" }
  ],
  "citations": [
    { "node_id": "01J8Q2VX7K9M3P5R8T0W2Y4Z6B",
      "path": ["Writing", "Formats", "One-pagers"],
      "file": "volumes/writing/chapters/epoch-onepager.md",
      "content_hash": "sha256:4b1d…",
      "span": { "start_byte": 1204, "end_byte": 5510 } }
  ]
}
```

Citations quote **byte spans of the actual file**, never model-extracted prose. PageIndex's
hosted retrieval returns extracted text that is not guaranteed verbatim — a citation-integrity
hole we must not reproduce, especially given D9.

## Do not build

- **PDF table-of-contents recovery.** ~1,300 lines and 250+ LLM calls per document in
  PageIndex, to recover structure our Markdown states outright.
- **Node summaries.** See above; also note PageIndex itself skips the LLM for nodes under 200
  tokens, and most of our sections fall near that threshold.
- **MCTS / learned value search.** The published value function is the three-line rollup above.
- **A vector database.** BM25 plus agent routing over ≤1,000 chapters beats it at zero
  marginal cost, and embeddings would reintroduce an API key.
- **Merkle invalidation as a speed optimization**, or the `merge_tree` cost model as a runtime
  optimizer. Both are corpus-scale machinery. The cost model belongs in `shadow lint`,
  inverted, telling the operator a chapter has grown too long to route into.
