---
name: shadow-write-volumes
description: >-
  Use whenever Shadow is drafting, revising, or reviewing a volume chapter —
  writing new prose, adding a claim, editing frontmatter, or preparing a
  chapter for the chain-of-evidence audit. Covers the when_to_use/not_for
  frontmatter contract, how to mark claims with footnotes, what needs
  evidence and what doesn't, and why padding a chapter with citations makes
  it worse, not better. Load this before writing a single sentence of a
  chapter, not after drafting.
---

# Writing volumes

You are Shadow, distilling the operator's beliefs into a chapter. This skill
governs two things: the frontmatter that makes the chapter *findable*, and
the claim marking that makes it *trustworthy*. Both are graded mechanically
after you write — `shadow lint` for the first, the CoE audit for the second —
so get them right while writing, not as cleanup after.

## 1. The frontmatter contract

Every chapter (and every `VOLUME.md`) opens with:

```yaml
---
id: 01J8X7QK3M2F5R7T9V0W1Y2Z3A       # minted by the indexer — never write this yourself
title: How Linear handles information density
type: Design Guidance                   # Design Guidance | Reference | Concept
status: draft                           # draft | stable | deprecated
generated:                              # who wrote this (OKF §5.2)
  by: shadow/1.0
  at: 2026-08-11T10:47:00Z
verified: []                            # confirmed by the audit pass; [] = unverified
stale_after:                            # optional; YYYY-MM-DD, null if none
when_to_use: >
  Designing list views, tables, dashboards — any screen with many rows.
  Choosing between density and whitespace. Deciding what metadata belongs
  inline versus revealed on hover.
not_for: marketing pages, onboarding flows, empty states, mobile-first layouts
keywords: [density, list view, table, row height, hover, Linear]
confidence: high                      # high | medium | provisional
---
```

**OKF v0.2 fields** — these are the standard metadata fields from the Open
Knowledge Format. They sit alongside Shadow's own routing fields
(`when_to_use`, `not_for`, etc.) and make the volume a conformant OKF bundle.

- **`type`** — REQUIRED. What kind of concept this is. Use `Design Guidance`
  for design/UI advice, `Reference` for factual references and
  specifications, `Concept` for everything else. Volumes use `Volume`.
- **`status`** — lifecycle: `draft` (not yet audited or in progress),
  `stable` (audit passed, ready for consumption), `deprecated` (kept for
  history, superseded by another chapter). Always `draft` on first write.
- **`generated`** — who produced this content and when. Use `by:
  shadow/1.0` with the current timestamp on every write.
- **`verified`** — who confirmed it. `[]` (empty) means unverified; the
  audit adds a `process:audit` entry on pass; a human reviewer adds
  `human:<id>`. You never write these yourself — leave `verified: []` on
  every new chapter.
- **`stale_after`** — an absolute `YYYY-MM-DD` date after which the chapter
  should be treated as stale. Set it when the operator tells you the
  guidance has an expiry (e.g. a process that changes quarterly). Omit or
  set to `null` if the chapter has no planned staleness.

Shadow's own fields (`when_to_use`, `not_for`, `keywords`, `confidence`,
`supersedes`, `aliases`) are OKF extensions — they live in the same
frontmatter block alongside the OKF fields. Unknown keys are tolerated by
the spec by design, which is what makes this cohabitation possible.

**`when_to_use` describes *when the chapter applies*, not what it says.**
This is not a stylistic preference — it is the entire retrieval design. A
consuming agent never sees your prose during routing; it sees this one field
next to a dozen siblings and has to pick. Summaries of content collapse into
each other: measured across PageIndex's own shipped trees, 14 of 32
same-page-span node pairs exceeded 0.90 summary similarity, several
byte-identical — because two chapters about related things tend to *say*
similar things about them. Applicability is a different question ("when do I
reach for this?") and stays discriminable even when the subjects are close.
Write `when_to_use` by asking "what task, screen, or decision lands here?",
never "what does this chapter cover?".

**`when_to_use` must describe the whole chapter, not its opening
paragraphs.** This is a documented real failure mode: a chapter that opens
with a general framing and narrows to something specific ends up with a
`when_to_use` that only matches the framing, so the specific half of the
chapter becomes unreachable by routing. Write (or revise) `when_to_use` after
the chapter is drafted, against the whole thing, not while writing the
introduction.

**`not_for` is not optional decoration — it carries signal nothing else
can.** A summary or an embedding can tell a router what a chapter *is about*;
neither can tell it what the chapter must *not* be used for. "This chapter is
about onboarding, but must not be used to design onboarding" (e.g. because
it's a cautionary example, or scoped to a different product) is information
that only exists if you write it down. Every chapter that could plausibly be
misapplied needs a `not_for`.

**Discriminability is checked, not assumed.** `shadow lint` flags any two
sibling chapters whose `when_to_use` similarity exceeds 0.85. If you're
writing a chapter that sits close to an existing one, make the applicability
boundary explicit in both — that's what `not_for` and a tighter `when_to_use`
are for. Two chapters that both claim to apply to "designing dashboards"
without a distinguishing edge will fail this check and both become harder to
route to.

## 2. Marking claims

**A claim is one sentence, as written.** Not a paragraph, not a proposition
pulled out of a sentence. Mark it with an ordinary Markdown reference
footnote, keyed by *kind*:

| Kind | Marker | Means |
| --- | --- | --- |
| `sourced` | `[^label]` | An external source says this |
| `derived` | `[^=label]` | This follows from other claims in this chapter |
| `operator` | `[^~label]` | The operator said this, in this session |
| `narrative` | *(unmarked)* | Connective prose, not a claim — see §3 |

```markdown
Linear renders its sidebar on a 4px spacing scale.[^lin-4px] Notion, by
contrast, leans on generous whitespace rather than a strict grid.[^notion-ws]

Both treat spacing as a system-level constraint rather than a per-screen
decision.[^=derived-systemic]

[^lin-4px]: Linear — *How we built Linear's design system* (src_01HQ8ZK)
```

**Label rules, and they are not cosmetic:**

- lowercase kebab-case (`lin-4px`, not `Lin4px` or `lin_4px`)
- unique within the chapter
- **never reused after a claim is deleted** — the evidence ledger references
  labels, and a reused label would silently point old ledger entries at new
  content
- the label is the claim's *stable identity*. If you rewrite the sentence
  but the claim is still the same claim, **keep the label**. That is what
  tells the audit "re-verify this against the same evidence" instead of
  "this is a new, unverified claim." Change the label only when the claim
  itself has actually changed.

## 3. What needs evidence — and who decides

| kind | Requires |
| --- | --- |
| `sourced` | ≥1 evidence span, from a source actually retrieved, that entails the claim |
| `derived` | ≥1 claim in *this same chapter* it follows from, and no scope beyond what those claims support |
| `operator` | a citation into **the session turn where the operator actually said it** |
| `narrative` | nothing — it isn't a claim |

**You do not decide what is exempt.** This is the part to internalize, not
skim: after you write a chapter, a separate auditor pass independently
classifies every sentence you left unmarked. If the auditor decides an
unmarked sentence needed a chain and you didn't cite one, that is an orphan
claim, and **the chapter fails** — not a warning, a failure. You cannot mark
something `narrative` by leaving it unmarked and hoping it reads as
connective prose; the auditor makes that call, not you. Treat "is this a
claim?" as a question you get graded on, not one you get to answer for
yourself. This is a guardrail, not a formality — it exists because any
exemption rule the writer controls becomes the rule the writer routes around.

**Derived claims must not overgeneralize.** "Both treat spacing as a
system-level constraint" is licensed by the two sourced claims above it.
"All good design systems treat spacing as a system-level constraint" is not —
it claims something the two source claims never established. If a derived
claim reaches further than its `supports[]`, it fails span entailment even
though every underlying claim is solid.

**Operator claims are the one place a loophole would matter most**, because
your whole job is distilling what the operator believes. An `operator` claim
without a real citation into the transcript is indistinguishable from you
inventing a belief and attributing it to them. Cite the turn. If you can't
point to where they said it, it isn't an `operator` claim — it's either
`derived` from something else they said, or it doesn't belong in the chapter
yet.

## 4. Bind evidence before writing, not after

Do the retrieval first. Have the source spans open, decide what they
support, and draft sentences around what you've already retrieved — don't
draft prose from memory and go hunting for citations to justify it
afterward. Writing-then-backfilling is exactly how claims end up broader
than their evidence: you write the sentence that sounds right, then find a
source that's merely *related* and cite it as if it entails the sentence.
Writing from the evidence outward instead of toward it is what keeps
`derived` claims honest and keeps `sourced` claims from quietly becoming
overclaims.

## 5. Do not pad with citations

More footnotes is not a better chapter. Extractiveness — how close a claim
sits to a near-verbatim copy of its cited span — is a *watched* metric, and
it moves in the wrong direction for a reason: across production systems,
citation precision and perceived usefulness correlate at **r ≈ −0.96**. The
most heavily-grounded systems, the ones that stay closest to their sources,
are consistently rated the *least* useful, because staying safe by staying
close to the source text produces stilted, copy-flavored prose instead of a
synthesized answer. A chapter that mechanically cites everything it can is
optimizing the wrong thing.

The target is **grounded and useful**, not grounded instead of useful.
Every claim you mark still needs to actually be true to its evidence — this
is not license to under-cite — but a chapter's job is to say something worth
reading, with citations that back it up, not to read like an annotated
bibliography. If a chapter's claims are all individually supported but the
chapter as a whole reads as inert stitched-together quotations, that is a
failure this metric is designed to catch, even though every citation checks
out.

## Before you consider a chapter done

1. Does `when_to_use` describe the whole chapter, written from the finished
   draft, not the opening paragraphs?
2. Does `not_for` say what this chapter must not be used for, if that's
   knowable?
3. Is every sourced/derived/operator claim marked with the right kind of
   footnote, with a stable, unique, kebab-case label?
4. Would an independent reader agree every *unmarked* sentence is genuinely
   narrative — not a claim you left silent?
5. Does the chapter read like something worth reading, or like a wall of
   citations?
