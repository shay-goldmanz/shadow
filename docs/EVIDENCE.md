# Chain of evidence specification

Implementation spec for `@shadow/evidence`. Decisions and rationale live in `DECISIONS.md`
(D9, D15, D16, D18–D21); this document is the contract to build against.

Acceptance requires *"a ScientistOne-like chain of evidence… so every volume he creates or
edits is grounded in traceable sources and not hallucinated."* Science One defines the chain
as two properties — **completeness** (every claim carries a recorded evidence chain) and
**correctness** (each chain genuinely supports its claim) — and specifies properties rather
than implementation. Everything below beyond those properties and the four-check audit shape
is our design.

## The two hard questions

### What is a claim, and how is it marked

**A claim is a sentence, as written.** Not a proposition extracted from it, not a paragraph.

Decomposition granularity is the single largest source of variance in this field. The same
text with the same verifier but a different decomposition strategy moves scores 33.00 → 61.51,
flipping 19% of individual judgments. Decompose-then-verify is also trivially gameable —
padding with obvious subclaims inflates precision, dropping FActScore 83.0 → 36.2 under
attack. If we never decompose, none of that can happen to us. It is also the unit the
operator edits, which matters because D4 exists so they can open a chapter and correct it.

**Marking uses ordinary Markdown reference footnotes, plus a sidecar.**

```markdown
Linear renders its sidebar on a 4px spacing scale.[^lin-4px] Notion, by
contrast, leans on generous whitespace rather than a strict grid.[^notion-ws]

Both treat spacing as a system-level constraint rather than a per-screen
decision.[^=derived-systemic]

[^lin-4px]: Linear — *How we built Linear's design system* (src_01HQ8ZK)
```

Valid Markdown, renders as a citation, readable raw, and idiomatic. The load-bearing property
is that **the label is a stable identity the operator preserves through edits**. If they
rewrite the sentence but keep `[^lin-4px]`, we know with certainty this is the same claim
restated, so we re-verify against the same evidence. Anchoring by quoting the sentence instead
would show an orphan plus a new unsourced claim, and we would have to guess.

This is why the two sides of the chain anchor differently:

| | Problem | Mechanism |
|---|---|---|
| Claim → chapter | We own the file; the operator edits deliberately. We need **identity through revision**. | Stable inline label, exact match. Tier 0, free. |
| Evidence → source | We do not own the page; it drifts silently. We need **durability against unannounced change**. | `TextQuoteSelector` over an immutable local snapshot. |

Labels are lowercase kebab-case, unique within a chapter, and **never reused after deletion** —
the ledger references them.

### What is exempt, without creating a loophole

If the writer decides what needs evidence, everything inconvenient becomes exempt. **So the
writer does not decide.**

The writer marks what it cites. A **separate auditor pass independently classifies every
sentence** as check-required or not. For any sentence with no footnote, the auditor asks
"should this have had one?" If yes → **orphan claim → the chapter fails**. The writer cannot
exempt itself by staying silent, because silence is exactly what gets audited. This
generalizes Science One's Ground stage — deterministic validation run separately from and
after the model that wrote the text.

| kind | Marked | Requires | Exempt from |
|---|---|---|---|
| `sourced` | `[^label]` | ≥1 evidence span that entails it | — |
| `derived` | `[^=label]` | ≥1 `supports[]` pointing at claims in this chapter, no scope beyond them | external evidence |
| `operator` | `[^~label]` | a citation into **the session turn where the operator said it** | web evidence |
| `narrative` | unmarked | nothing | everything |

**`operator` is where the loophole would have been.** Shadow's product is distilling the
operator's beliefs, so there must be a category for "this is what they think" — but if that
category is free-form it licenses writing anything and labelling it belief. So operator claims
carry evidence too: a citation into the chat transcript, which is a retrievable, hashable
artifact stored exactly like a web page with `transport: "session"`. Shadow cannot mint a
belief the operator never expressed, for the same structural reason it cannot mint a citation
to a page it never fetched. This extends D9's guardrail: the transcript is the *second* and
only other legitimate origin of a source record.

`narrative` is bounded three ways: Tier 0 form-based exclusion (headings, list scaffolding,
code blocks, attributed blockquotes), the Tier 2 check-worthiness sweep above, and a **visible
budget** — `narrativeRatio` is reported per chapter. Perfect classification is not required;
abuse only has to be *visible*.

**Check-required is the denominator, and this matters more than it sounds.** Sentences with
`checkRequired: false` are excluded from **both** numerator and denominator of every
groundedness metric. Collapsing "not check-worthy" into "unsupported" is the most damaging
labelling error in this space: do it and every well-written chapter — the ones with topic
sentences and transitions — scores as ungrounded, pushing Shadow toward stilted,
citation-stuffed prose.

## On-disk layout

```
~/.shadow/volumes/<slug>/evidence/
  manifest.json                          schema version, counts, per-chapter audit status
  sources/<source-id>.json               one per retrieved source
  snapshots/<normalizedTextSha256>.txt   immutable extracted text, content-addressed
  claims/<chapter-slug>.claims.json      sidecar: claims + chains for one chapter
  audits/<chapter-slug>.audit.json       last audit result
  ledger.ndjson                          append-only event log
```

Snapshots are content-addressed, so identical fetches dedupe and a changed source produces a
*new* file rather than mutating one. Claims are per-chapter so an edit touches exactly one
sidecar — that is what makes per-edit auditing cheap and the git diff readable.

## Source record

```jsonc
{
  "schemaVersion": "1.0",
  "id": "src_01HQ8ZK4M2N7P9R3T5V8W1X6Y0",        // ULID, immutable
  "url": "https://linear.app/blog/design-system",
  "finalUrl": "https://linear.app/blog/design-system",
  "title": "How we built Linear's design system",
  "author": "Linear",                              // nullable
  "publishedAt": "2024-03-11",                     // nullable

  "retrieval": {
    "retrievedAt": "2026-08-11T09:14:22Z",
    "agent": "@shadow/research/web-tool-agent@0.1.0",
    "transport": "live",                           // live | fixture | session
    "query": "how Linear designs its UI system",
    "httpStatus": 200,
    "contentType": "text/html"
  },

  "snapshot": {
    "path": "snapshots/9f2b7c1e….txt",
    "payloadSha256": "sha256:4a1d3e…",             // RAW bytes — forensics only, never alerts
    "normalizedTextSha256": "sha256:9f2b7c1e…",    // THE ALERT TRIGGER; also the filename
    "normalization": "nfc-ws-v1",
    "chars": 48213,
    "archived": { "mementoUrl": "…", "mementoDatetime": "…" }   // optional
  },

  "authority": { "tier": "primary", "rationale": "First-party publisher of the subject." },
  "volatility": "slow-changing"                    // never | slow-changing | fast-changing | unknown
}
```

**Two digests, and this is the most important correction in the schema.** Content drift affects
~3 in 4 URI references; outright reference rot only ~1 in 5. The page usually still resolves,
it just no longer says what was cited. A single hash over raw bytes churns on every ad
rotation and timestamp, so it fires constantly and gets ignored. Only
`normalizedTextSha256` raises a staleness alarm. WARC standardized this same split as
block-digest vs payload-digest.

`authority.tier` is a 4-value enum (`primary | secondary | community | unknown`) describing
**relationship to the subject**, not a credibility score. "Is this the subject writing about
itself?" is objectively answerable; "how credible is this?" is not, and a numeric score would
be invented precision. It is advisory — used to order evidence and annotate conflicts, never
as a gate.

## Claim sidecar

```jsonc
{
  "schemaVersion": "1.0",
  "chapter": "how-linear-designs-ui",
  "chapterTextSha256": "sha256:1a4c…",
  "auditedAt": "2026-08-11T09:31:07Z",

  "claims": [{
    "id": "clm_01HQ8ZK…",                          // ULID, immutable, never reused
    "label": "lin-4px",                            // the [^lin-4px] marker
    "kind": "sourced",
    "text": "Linear renders its sidebar on a 4px spacing scale.",
    "decontextualized": "Linear renders the sidebar of its application on a 4px spacing scale.",
    "checkRequired": true,                         // SET BY AUDITOR, never by the writer

    "evidence": [{
      "sourceId": "src_01HQ8ZK…",
      "snapshotHash": "sha256:9f2b7c1e…",          // pins WHICH version
      "selector": {
        "type": "TextQuoteSelector",
        "exact": "Every measurement in the sidebar is a multiple of four.",
        "prefix": "we settled on a strict grid. ",
        "suffix": " This removes a whole class of",
        "refinedBy": { "type": "TextPositionSelector", "start": 8817, "end": 8871 }
      },
      "state": { "type": "TimeState", "sourceDate": "…", "cached": "…" },   // optional
      "relation": "supports",                      // supports | partial | contradicts | context
      "anchorStatus": "anchored"                   // anchored | anchored-fuzzy | orphaned
    }],

    "supports": [],                                // non-empty for `derived`

    "verification": {
      "status": "supported",                       // supported|partial|unsupported|conflicted|unchecked
      "checkedAt": "2026-08-11T09:31:44Z",
      "checkedBy": "llm-judge/claude@shadow-model",
      "inputHash": "sha256:c31d…",                 // THE MEMOIZATION KEY
      "rationale": "The source states every sidebar measurement is a multiple of four.",
      "relevance": "on-topic",                     // on-topic | off-topic  (C5)
      "conflictsWith": []
    }
  }],

  "narrative": { "sentences": 61, "ratio": 0.41, "classifiedBy": "llm-judge/claude@shadow-model" }
}
```

`derived` claims additionally carry `overgeneralizationRisk` (`low|medium|high`).
`operator` claims verify at **Tier 0** — exact substring match against the session snapshot.
No model, no cost: the operator either said it or did not.

Field names follow the W3C Web Annotation REC (`TextQuoteSelector`, `refinedBy`, `TimeState`,
and an `evidence[]` entry that is a `SpecificResource` in all but name) so the ledger is
exportable rather than proprietary. The chain also maps cleanly onto PROV-O
(`wasQuotedFrom`, `specializationOf`, `hadPlan`) if we ever need it.

## Ledger

Append-only NDJSON — one object per line, so appends produce clean git diffs.

```jsonc
{"ts":"…","event":"source.retrieved","sourceId":"src_…","normalizedTextSha256":"sha256:9f2b…"}
{"ts":"…","event":"claim.verified","claimId":"clm_…","status":"supported","inputHash":"sha256:c31d…"}
{"ts":"…","event":"claim.restated","claimId":"clm_…","from":"Linear never uses shadows.","to":"Linear's documentation emphasises borders over shadows.","reason":"overclaim: source states a preference, not an absolute","levenshtein":47}
{"ts":"…","event":"source.drifted","sourceId":"src_…","was":"sha256:11aa…","now":"sha256:22bb…","invalidatedClaims":3}
{"ts":"…","event":"audit.completed","chapter":"…","result":"pass","completeness":1.0,"narrativeRatio":0.41}
```

The ledger is what the operator reads to see **what Shadow softened and why** — the D9
requirement that thin evidence stays visible rather than being quietly cleaned up.

## Normalization and anchoring

`nfc-ws-v1`, applied once at snapshot time:

1. Extract main content (readability-style); discard nav, footer, script, style
2. Unicode **NFC** normalize
3. Collapse whitespace runs to a single space; line endings to `\n`
4. Trim
5. UTF-8 encode; SHA-256 over those bytes

**Store character offsets, not byte offsets**, and document it. Anthropic and OpenAI are
character-indexed; Google and Vertex are byte-indexed and will mis-slice non-ASCII. This is a
real bug class. (Note this differs from `INDEXING.md`, which uses byte spans into our *own*
Markdown files — a separate concern.)

```
resolve(selector, snapshotText) -> { start, end, status }

1. if selector.refinedBy present:
     if snapshotText.slice(start, end) === selector.exact:
         return anchored                      // O(1) fast path
2. exact indexOf scan for selector.exact
     one match  -> anchored
     many       -> score candidates by prefix/suffix similarity, best -> anchored
3. approximate search; best candidate above threshold -> anchored-fuzzy
4. orphaned
```

**Step 1's re-validation is the whole trick and the step reimplementations skip.** A cached
offset that no longer contains `exact` is *rejected*, not trusted. `refinedBy` is a cache; the
quote is the identity.

Context length (start at 32 chars), edit-distance budget (start at `min(256, exact.length/2)`),
field weights and accept threshold are **tunable configuration calibrated against the fixture
corpus**, not established constants. The W3C REC defines exact-match semantics only — fuzzy
matching is our extension, which is why `anchorStatus` is recorded rather than assumed.

**Orphan is a state, not an error.** It renders as a warning, never a failure. If the cited
text was deleted outright, no algorithm recovers it — say so plainly.

## The five checks

Science One's I1 (score verification) and I2 (specification violation) presuppose a golden
evaluator and a solution code artifact. **Shadow has neither**, and the paper concedes this for
open-ended domains. Forcing a fake I1 would produce a check that looks like the original and
measures nothing.

| | Check | Tier | What it does |
|---|---|---|---|
| **C1a** | Structural completeness | 0 | Every `[^label]` has a claim record and vice versa; labels unique and never reused; `sourced`/`operator` have non-empty `evidence[]`; `derived` has non-empty `supports[]` with all targets present and no cycles |
| **C1b** | Check-worthiness sweep | 2 | Independently classify every **unmarked** sentence. Auditor says it needs a chain and the writer did not cite it → **orphan claim → fail**. Emits `narrativeRatio`. |
| **C2** | Source integrity | 0 | Every `sourceId` and `snapshotHash` exists; re-hashing reproduces the filename; every `selector.exact` **resolves** in its pinned snapshot. Plus the **numeric sub-check**: every numeral in a claim appears in a cited span within 5% relative tolerance. |
| **C3** | Span entailment | 2 | Does the resolved span support the decontextualized claim? For `derived`: does the conclusion follow from `supports[]` without overgeneralizing? |
| **C4** | Index alignment | 2 | Every claim in an `index.json` node summary or `when_to_use` appears in, or is entailed by, the chapter beneath it |
| **C5** | Chapter relevance | 2 | Does each claim serve the chapter's stated subject? Non-blocking warning. |

**C2 is stronger than Science One's I3.** I3 checks a bibliography entry exists in an academic
API; C2 checks the exact quoted text is present in a byte-identical local copy of what was
actually fetched. **C3 is the gap Science One explicitly names as future work**: *"A real
citation can still be used to support a claim the cited paper never made."*

**The numeric sub-check is the cheapest high-value thing here.** Science One's
highest-confidence result is 98.1% numerical provenance from *deterministic* 5%-tolerance
comparison with no model at all. It catches transcription errors entailment judges wave
through. Allowlist the known false-positive classes: version numbers, dates, hex values.

**Verdict:** a chapter passes iff C1a, C1b and C2 pass fully and C3 has zero `unsupported`.
`partial`, `conflicted` and `off-topic` do **not** block — they route to restatement and
surface as warnings.

## Tiers: what runs when

```
on chapter save:

TIER 0 — pure code, no model, milliseconds, ALWAYS, and in every offline test
  C1a structural completeness
  C2  source integrity + span resolution + numeric sub-check
  operator-claim exact-quote verification
  compute per claim:
    inputHash = sha256(decontextualized ‖ evidence[].exact ‖ snapshotHash ‖ supports[])

TIER 2 — LLM judge, ONE batched session (D6)
  C1b check-worthiness  → only unmarked sentences that are new or changed
  C3  span entailment   → only claims where inputHash ≠ verification.inputHash
  C5  relevance         → same claims as C3, same prompt turn
  C4  index alignment   → only if the chapter's routing metadata changed
```

**`inputHash` is the entire cost story.** Rewriting a sentence's prose without changing its
claim or evidence re-runs nothing. Adding one claim judges one claim. A drifted source
invalidates only the claims citing that snapshot. A typical edit touches 1–5 claims: one
session, a handful of judgments. The expensive case is the first full audit of a fresh
chapter, and it happens once.

**Offline testability falls out for free.** Tier 0 needs only the filesystem. Tier 2 sits
behind the `@shadow/model` port, so fixture-recorded verdicts replay deterministically. **The
entire completeness property and the entire anti-fabrication property are Tier 0** — fully
testable with no network and no model.

Tier 1 (a small local entailment model as a pre-filter) is **deliberately deferred**: it would
introduce a non-subscription model dependency, cutting against D5. It is the lever to pull if
judge cost bites.

## Conflict, recency, repair

Science One specifies none of this. For a system distilling design beliefs, where sources
routinely disagree, it is not optional.

**Conflict → surface, do not resolve.** When evidence disagrees, set `status: "conflicted"`,
populate `conflictsWith`, and require prose of the form "X holds A, while Y holds B," both
cited. WikiContradict is decisive here: 253 *real* contradictions from equally-trustworthy
sources, where credibility ranking cannot help. Contradiction-aware prompting moved one model
from 10.4% → 43.8% at surfacing them. No vendor API detects conflict; we compute it with
pairwise checks across candidate spans *before* generation.

**Recency** is driven by per-source `volatility`, not a global TTL. A `fast-changing` source
older than 90 days warns and queues a refetch; `never` never expires.

**Repair follows D9: restate conservatively, never silently delete.**

| Verdict | Action |
|---|---|
| `partial` | rewrite to the scope the evidence supports; log `claim.restated` with `levenshtein` |
| `unsupported` | rewrite; downgrade to `operator` **only with operator confirmation**, never silently |
| `conflicted` | rewrite to surface both positions, cite both |
| `off-topic` | flag only — the fix is usually deletion or a different chapter |
| `orphaned` | refetch; if genuinely gone, warn and surface |

**Two guardrails, because a naive repair loop is trivially gameable.**

1. **Preservation bound.** RARR's warning: *"an adversarial editor could ensure 100%
   attribution by simply replacing the input with the text of any arbitrary retrieved
   document, which is trivially attributable to itself."* Reject any restatement whose
   Levenshtein distance exceeds `max(80 chars, 0.5 × original length)`; escalate to the
   operator instead. Log the distance either way.
2. **Extractiveness as a watched metric.** Mean longest-common-substring between claim and
   cited span. Citation precision and perceived utility correlate at **r ≈ −0.96** across
   generative search engines — heavily-supported statements trend toward near-extractive
   copying. **If Shadow's volumes get more grounded and less useful, the metric is working and
   the product is failing.** Extractiveness rising alongside groundedness is that signal.

## Metrics

| Metric | Definition |
|---|---|
| Claim completeness rate | `#claims with a chain / #check-required sentences`. Target **1.0** — a gate |
| Claim provenance rate | `#claims resolving and entailing / #check-required claims` |
| Citation precision | `#spans judged supporting / #spans` |
| Citation recall | `#claims whose evidence set *jointly* entails / #sourced claims` |
| Numeric CPR | Tier-0 numeric sub-check pass rate |
| Orphan rate | `#unresolvable selectors / #selectors` — expect growth with corpus age |
| Narrative ratio | the exemption budget, made visible |
| Relevance rate | C5 on-topic fraction |
| Extractiveness | **guardrail, not target** |
| `holesRatio` | `#claims evaluated with no human label / #claims evaluated` (D17) |

**Golden set: ~150 claims**, drawn from the fixture corpus so it is stable and offline.
Stratify by `kind`, by verdict (**oversample failures** — they discriminate), and by
volatility. Label set: `supported / partial / unsupported / conflicted / not-check-required`.

Two annotation rules that materially change results: judge decontextualizability **with the
source hidden** first, then attribution with it shown — annotators who can see the source
unconsciously back-fill ambiguity. And **randomize evidence-span order** in judge prompts,
since judges systematically prefer the first-displayed candidate strongly enough to reverse
verdicts.

Report Cohen's κ against operator labels. Realistic targets ~0.65–0.70 on
supported/unsupported, materially lower on `partial` — which is where the judge will be
weakest, and where the sentence-as-claim decision concentrates its cost.

**The golden set calibrates the judge; it does not score Shadow.**

## What is ours versus Science One's

Taken directly: the two CoE properties as a publication gate, claim typing with per-type
dispatch, deterministic checks run before and separately from LLM checks, composition
downstream of verification, conservative restatement over deletion, the four-check audit
shape, and the numeric-tolerance check.

Ours, and marked as such: two-layer anchoring (stable label into our chapter, quote selector
into their source); content-addressed immutable snapshots with two digests; C3 passage-level
entailment (the limitation Science One names as future work); the `operator` kind citing the
transcript; the `narrative` kind with auditor-side check-worthiness; C5 relevance; conflict,
recency and authority fields; and `inputHash` memoization.

Science One never published an evidence-tag grammar, JSON schema, or class model. The only
published tag syntax is a file path and a line number.
