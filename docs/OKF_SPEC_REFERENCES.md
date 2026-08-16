# OKF v0.2 spec references

This is not a copy of the [Open Knowledge Format spec](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
(`GoogleCloudPlatform/knowledge-catalog`, `okf/SPEC.md`). Code and lint
messages across this repo cite OKF section numbers (`OKF §4.1`, `OKF §5.2`,
...) as the justification for specific checks, but the upstream document
itself isn't vendored here and this agent cannot fetch it. Every entry below
is instead **derived from how this codebase already uses and cites that
section** — its code comments, field semantics, and lint finding messages —
recorded so a reader can see what requirement a given conformance finding is
enforcing without reading the implementation. This is our understanding of
each section as the code encodes it, not a substitute for the upstream text.
**Upstream is authoritative.** If this document and the real spec ever
disagree, the real spec wins and this document is wrong.

## §4.1 — `type` required on every concept

Every OKF "concept" — which in this codebase means every chapter and every
volume (a volume's `VOLUME.md` is itself a concept) — must carry a
non-empty `type` string. It's cited as *the* one field OKF strictly
requires; everything else layered on top (`status`, `generated`, `verified`,
`stale_after`, ...) is additional metadata OKF defines but doesn't mandate
on every concept the way it mandates `type`. Shadow's own routing fields
(`when_to_use`, `not_for`, `keywords`, `confidence`, `supersedes`,
`aliases`, `id`) live alongside `type` as OKF extensions — §4.1 is read here
as explicitly permitting extension fields on a concept.

- Enforced in `packages/indexing/src/lint-okf.ts`, `checkOkfConformance` —
  finding codes `okf-missing-type` (chapters) and `okf-volume-missing-type`
  (volumes), both `error` severity.
- Typed in `packages/core/src/frontmatter-shared.ts`'s
  `hasRequiredTypedFields`, and enforced at parse time — `type` missing or
  empty fails to parse in `packages/core/src/frontmatter.ts` and
  `packages/core/src/volume-frontmatter.ts` (hard failure, not a lint
  warning: a document without `type` never becomes a `Chapter`/`Volume` in
  the first place).

## §5.1 — source credibility signals

Beyond the base fields Shadow's evidence sources already carried (`url`,
`title`, `author`, ...), OKF defines a family of "credibility signal"
fields that let a consumer judge how trustworthy and current a cited
source is without re-fetching it: `usage_count` (how often the source is
exercised), `last_modified` (when the source itself last changed, distinct
from when Shadow's record of it was generated), and `usage_window` (the
date range `usage_count` is measured over). These are additive and
optional — a source without them is still valid, just without the signal.

- Modeled in `packages/evidence/src/types.ts`, `SourceRecord` —
  `okfSourceId`, `usageCount`, `lastModified`, `usageWindow` fields, under
  the `---- OKF v0.2 credibility signals (§5.1) ----` section comment.
- Not currently checked by `shadow lint --okf` — no finding code exists for
  missing or malformed credibility signals as of this writing; only the
  frontmatter-level OKF fields (§4.1, §5.2, §5.4, §5.5) are validated by
  `checkOkfConformance`.

## §5.2 — `generated`/`verified` actor convention

Content on a chapter or volume is attributed to whoever (or whatever)
produced and confirmed it, via a shared `{ by, at }` actor shape (see §7).
`generated` records who/what produced the content and is required — every
chapter and volume must carry one. `verified` is a list of the same actor
shape recording who confirmed it; an empty list means unverified, not
missing. The `by` field follows a convention this codebase applies but
that OKF itself leaves open-ended: `<producer>/<version>` for automated
producers (e.g. `shadow/1.0`, written by
`packages/agent/src/chapter-draft.ts`), `human:<id>` for an operator, and
`process:<id>` for an automated process (e.g. `process:audit`, written by
`packages/agent/src/publish.ts` when an audit passes).

- Modeled in `packages/core/src/types.ts` (`OkfActor`, `Chapter.generated`,
  `Chapter.verified`, and the `Volume` equivalents).
- Parsed in `packages/core/src/frontmatter-shared.ts`'s `parseOkfActor` /
  `parseVerified` (`verified` accepts either a single mapping or an array).
- Enforced in `packages/indexing/src/lint-okf.ts`,
  `validateOkfCommonFindings` — finding codes `okf-missing-generated`
  (`generated` absent or missing `by`/`at`) and `okf-invalid-verified-by`
  (a `verified` entry missing `by`), both `error` severity.

## §5.3 — `verified` empty array = unverified

A concept with no `verified` entries is not an error — it's simply
unverified. This is called out separately from §5.2 because it's a
semantic reading of the empty-array case (absence of verification is a
valid, common state — most drafts haven't been audited yet), not a
structural validation rule.

- Documented at the field definition in `packages/core/src/types.ts`,
  `Chapter.verified` / `Volume.verified`: "Empty array = unverified."
- No lint finding exists for an empty `verified` array — by this reading,
  none should, since it isn't a violation.

## §5.4 — `status` lifecycle

Every chapter and volume carries a lifecycle `status`, one of `draft`
(exists but hasn't passed audit), `stable` (published, audit passed), or
`deprecated` (kept for history, superseded). `packages/agent/src/publish.ts`
is the only place that transitions a chapter to `stable`, and only after
`runAudit`'s verdict passes.

- Typed as `OkfStatus` in `packages/core/src/types.ts`.
- Parsed with a default in `packages/core/src/frontmatter-shared.ts`'s
  `parseOkfStatus` — an absent or unrecognized value defaults to `"draft"`
  rather than failing to parse.
- Enforced in `packages/indexing/src/lint-okf.ts`,
  `validateOkfCommonFindings` — finding code `okf-invalid-status` (value
  present but not one of `draft`/`stable`/`deprecated`), `error` severity.

## §5.5 — `stale_after`

An optional absolute date after which a chapter or volume should be
considered potentially out of date. It's consumer-visible (`shadow read`
surfaces it) rather than purely a lint-time concern, and it's stored/
compared as a plain `YYYY-MM-DD` date, not a full timestamp.

- Parsed in `packages/core/src/frontmatter-shared.ts`'s `parseStaleAfter`
  and formatted back with `toDateString`.
- Serialized for the lint layer in `packages/indexing/src/okf-input.ts`,
  `serializeOkfCommonFields` — truncated to `YYYY-MM-DD` "matching OKF
  §5.5" per that function's own comment.
- Enforced in `packages/indexing/src/lint-okf.ts`,
  `validateOkfCommonFindings` — finding code `okf-invalid-stale-after`
  (present but not a valid `YYYY-MM-DD` date), `warning` severity (not
  `error` — a malformed staleness date doesn't invalidate the concept the
  way a missing `type` or bad `status` does).

## §6.2 — external computation file reference

An Attested Computation's frontmatter may point `computation` at a
separate file holding the computation, as an alternative to inlining it in
the chapter body. If `computation` is absent, the chapter body's
`# Computation` code fence *is* the computation.

- Typed in `packages/core/src/types.ts`, `OkfAttestedComputation.computation`
  (optional `string`, a path).
- Not independently validated by `shadow lint --okf` — only presence of the
  computation itself (inline or via this field) matters to the
  `okf-attested-*` finding codes under §10.2, not which of the two forms
  was used.

## §7 — actor shape

The `{ by, at }` pair used everywhere an OKF concept needs to record who
did something and when — `generated`, and each entry of `verified` (§5.2).
`by` is a free-form identity string (see the `<producer>/<version>` /
`human:<id>` / `process:<id>` convention under §5.2); `at` is a timestamp.

- Typed once as `OkfActor` in `packages/core/src/types.ts` and reused for
  both `generated` and `verified` on both `Chapter` and `Volume`, rather
  than each concept defining its own attribution shape.

## §8 — `index.md` progressive disclosure

A human-readable, Markdown directory of a bundle's volumes and chapters,
generated alongside the machine-optimized `index.json` (which stays as the
retrieval artifact — `index.md` is additive, not a replacement). The
bundle-root `index.md` must declare `okf_version` in its YAML frontmatter
(shared with §12); per-volume `index.md` files list that volume's chapters
with descriptions and carry no frontmatter of their own.

- Generated in `packages/indexing/src/index-md.ts` —
  `generateRootIndexMd` (root, with `okf_version` frontmatter) and its
  per-volume counterpart.
- Read back (not just written) in `packages/indexing/src/okf-input.ts`'s
  `declaresOkfVersion`, which checks the root `index.md`'s frontmatter
  parses as YAML and contains an `okf_version` key.
- Enforced in `packages/indexing/src/lint-okf.ts` — finding code
  `okf-missing-root-index` (root `index.md` missing or not declaring
  `okf_version`), `warning` severity.

## §9 — `log.md` update history

An append-only, chronological, human-readable history of changes to a
volume's directory — date-grouped, newest-date-group first, generated from
the evidence ledger's events (chapter created, published, deprecated,
claim restated, audit completed, ...). A projection of the ledger, not a
replacement for it: the ledger remains the authoritative record.

- Generated in `packages/indexing/src/log-md.ts`'s
  `generateVolumeLogMd`.
- Existence checked in `packages/indexing/src/okf-input.ts`'s
  `loadOkfBundleArtifacts` (bundle-root `log.md`).
- Enforced in `packages/indexing/src/lint-okf.ts` — finding code
  `okf-missing-log` (bundle-root `log.md` missing), `warning` severity.

## §10.2 — Attested Computation required fields

When a chapter's `type` is `"Attested Computation"`, its frontmatter must
additionally carry: `runtime` (non-empty string — determines what
`parameters` mean and how `executor`/`attester` interpret it), a
non-empty `parameters` array (each entry needs `name`, `type`, and a
`required` boolean), `executor` (an object with a non-empty `resource`
naming what runs the computation), and `attester` (an object with a
non-empty `resource` naming the deterministic, no-LLM code that inspects a
run's receipt and returns a verdict). This is a frontmatter extension, not
a separate stored document type — `@shadow/core` never parses or validates
it; only the lint layer (which already has full frontmatter access via
`ChapterIndexNode`) does.

- Typed in `packages/core/src/types.ts`, `OkfAttestedComputation` /
  `OkfParameter`.
- Enforced in `packages/indexing/src/lint-okf.ts`'s
  `validateAttestedComputation` — finding codes
  `okf-attested-missing-runtime`, `okf-attested-missing-parameters`,
  `okf-attested-bad-parameter`, `okf-attested-missing-executor`,
  `okf-attested-missing-executor-resource`,
  `okf-attested-missing-attester`,
  `okf-attested-missing-attester-resource`, plus the umbrella
  `okf-attested-missing-fields` in `checkOkfConformance` when the chapter
  has no `attestedComputation` data at all. All `error` severity.

## §12 — `okf_version` declaration

The bundle as a whole declares which OKF version it conforms to via an
`okf_version` key in the bundle-root `index.md`'s YAML frontmatter (this
codebase writes `"0.2"`). Cited alongside §8 everywhere it's checked,
since the declaration lives inside the §8 artifact rather than being a
separate file.

- Written in `packages/indexing/src/index-md.ts`'s `generateRootIndexMd`.
- Read and validated in `packages/indexing/src/okf-input.ts`'s
  `declaresOkfVersion` and surfaced as the `okf-missing-root-index`
  finding in `packages/indexing/src/lint-okf.ts` (same finding code as
  §8 — the two requirements share one artifact and one check).

## Enforcement points

| § | Requirement | Enforced in | Finding code(s) |
|---|---|---|---|
| §4.1 | `type` required on every concept | `frontmatter-shared.ts` (parse-time hard fail), `lint-okf.ts` | `okf-missing-type`, `okf-volume-missing-type` |
| §5.1 | Source credibility signals | `evidence/src/types.ts` (`SourceRecord`) | *(none — not yet checked by lint)* |
| §5.2 | `generated`/`verified` actor convention | `frontmatter-shared.ts`, `lint-okf.ts` | `okf-missing-generated`, `okf-invalid-verified-by` |
| §5.3 | `verified` empty array = unverified | `core/src/types.ts` (doc comment) | *(none — not a violation)* |
| §5.4 | `status` lifecycle | `frontmatter-shared.ts`, `publish.ts`, `lint-okf.ts` | `okf-invalid-status` |
| §5.5 | `stale_after` | `frontmatter-shared.ts`, `okf-input.ts`, `lint-okf.ts` | `okf-invalid-stale-after` |
| §6.2 | External computation file reference | `core/src/types.ts` (`OkfAttestedComputation.computation`) | *(covered by the §10.2 codes)* |
| §7 | `{ by, at }` actor shape | `core/src/types.ts` (`OkfActor`) | *(structural — no dedicated finding)* |
| §8 | `index.md` progressive disclosure | `index-md.ts`, `okf-input.ts`, `lint-okf.ts` | `okf-missing-root-index` |
| §9 | `log.md` update history | `log-md.ts`, `okf-input.ts`, `lint-okf.ts` | `okf-missing-log` |
| §10.2 | Attested Computation required fields | `core/src/types.ts`, `lint-okf.ts` | `okf-attested-missing-runtime`, `okf-attested-missing-parameters`, `okf-attested-bad-parameter`, `okf-attested-missing-executor`, `okf-attested-missing-executor-resource`, `okf-attested-missing-attester`, `okf-attested-missing-attester-resource`, `okf-attested-missing-fields` |
| §12 | `okf_version` declaration | `index-md.ts`, `okf-input.ts`, `lint-okf.ts` | `okf-missing-root-index` (shared with §8) |

**Reachability:** through the real `shadow lint --okf` CLI wiring, the
store's parsers normalize or hard-fail before a record ever reaches
`checkOkfConformance` — so the field-validation codes above
(`okf-missing-type`, `okf-volume-missing-type`, `okf-missing-generated`,
`okf-invalid-verified-by`, `okf-invalid-status`, `okf-invalid-stale-after`)
are defense-in-depth against hand-edited or out-of-band records, not
diagnostics an operator can actually trigger through the CLI; the findings
reachable through `shadow lint --okf` are `okf-missing-root-index`,
`okf-missing-log`, the `okf-attested-*` family, and `okf-stale-index` (an
index chapter node with no matching store record — not tied to any spec
section, since a stale index isn't an OKF violation).

All checks above run zero LLM calls and zero network calls (`checkOkfConformance`
in `packages/indexing/src/lint-okf.ts` is pure: input bag in, findings out) and
are wired into the CLI via `shadow lint --okf` (`packages/cli/src/commands/lint.ts`).
