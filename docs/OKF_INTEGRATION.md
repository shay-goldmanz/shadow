# OKF v0.2 Integration Plan

**Goal:** Full conformance — Shadow volumes *are* OKF bundles, with no
breaking changes to existing functionality.

**Branch:** `feat/okf-integration`

## Status

This plan has shipped: the `type`/`status`/`stale_after`/`generated`/`verified`
frontmatter fields, `index.md`/`log.md` generation, `shadow lint --okf`
conformance checking, and Phase 4's `type: "Attested Computation"` chapters
are all built and covered by tests (see `docs/OKF_SPEC_REFERENCES.md` for
where each requirement is enforced). There is no `shadow migrate` command and
none is planned — see [Migration](#migration) below for why.

## Gap summary

Shadow's volume format (Markdown + YAML frontmatter chapters in a directory tree)
is already 80% OKF. The work is schema alignment plus three new artifacts.

## Phase 1 — Frontmatter alignment (week 1)

### 1.1 Add `type` to every chapter

- `type` is the only OKF-required field; every chapter gets one
- Shadow writes it at draft time (agent skill update)
- For existing volumes, a migration infers `type` from the chapter's role:
  `Design Guidance`, `Playbook`, `Reference`, `Concept`
- Validation: `shadow lint` checks `type` is present and non-empty

### 1.2 Add `status` (lifecycle)

- `draft` → chapter exists but hasn't passed audit
- `stable` → published, audit passed
- `deprecated` → kept for history, superseded
- Maps trivially: unaudited = draft, audited+pass = stable, superseded = deprecated

### 1.3 Add `stale_after`

- Absolute date, optional
- Consumer-visible: `shadow read` warns when stale
- `shadow lint` flags stale chapters

### 1.4 Align `generated` / `verified` with OKF actor convention

- `generated: { by: "shadow/1.0", at: "..." }` — Shadow always writes
- `verified: [{ by: "human:<id>", at: "..." }]` — operator review
- `verified: [{ by: "process:audit", at: "..." }]` — automated audit pass
- Use actor convention: `<producer>/<version>`, `human:<id>`, `process:<id>`

### 1.5 Align `sources` with OKF credibility signals

- Evidence sources already have `url`, `title`, `author`
- Add OKF fields: `usage_count`, `last_modified`, `usage_window`
- Backward-compatible: new fields are optional

### 1.6 Preserve Shadow extensions

Shadow's own routing fields live as OKF extensions (OKF §4.1 explicitly allows this):

- `when_to_use`, `not_for`, `keywords`, `confidence`
- `supersedes`, `aliases`, `id` (ULID)

**Files touched:** `@shadow/core/types.ts`, `@shadow/core/volume-frontmatter.ts`,
`@shadow/core/frontmatter.ts`, `@shadow/evidence/types.ts`, `@shadow/agent`,
skills, and every test fixture.

---

## Phase 2 — Bundle structure (week 2)

### 2.1 Generate `index.md` per volume

- Produced by `@shadow/indexing` alongside `index.json` (both coexist)
- `index.json` stays as the machine-optimized retrieval artifact
- `index.md` is the human-readable OKF progressive-disclosure file
- One section per volume, listing chapters with descriptions
- Root-level `index.md` carries `okf_version: "0.2"`

### 2.2 Generate `log.md` per volume

- Append-only chronological history of changes
- Date-grouped entries, newest first
- Events: chapter created, published, deprecated, claim restated, audit completed
- Generated from the evidence ledger

### 2.3 Cross-linking audit

- Internal links between chapters: adopt bundle-relative `/volumes/<slug>/chapters/<slug>.md`
- Node references (`node_id`) stay as the machine reference; add path as human-readable
- No breaking change — adds path, doesn't remove node_id

**Files touched:** `@shadow/indexing`, `@shadow/evidence`

---

## Phase 3 — OKF conformance validation (week 2–3)

### 3.1 `shadow lint --okf`

- Validates bundle conformance against OKF v0.2
- Checks: every `.md` has parseable frontmatter, `type` is present, `index.md`/`log.md` structure
- Non-blocking for Shadow-specific extensions

### 3.2 OKF consumer tolerance

- Ensure API responses don't break on OKF fields
- Tests: an external OKF consumer can read a Shadow volume without Shadow-specific knowledge

---

## Phase 4 — Attested Computations (week 3, optional)

### 4.1 Add `type: Attested Computation` support

- New concept type: a computation with `runtime`, `parameters`, `executor`, `attester`
- Shadow can draft them; audit verifies computation contract
- Consumer can run attestation

### 4.2 `references/` convention

- Mirror external material as concepts
- Executor/attester code lives in `references/`

---

## What does NOT change

- **`index.json` stays** — it's the retrieval-optimized artifact; `index.md` is additive
- **`VolumeStore` interface stays** — OKF is an on-disk format, not a new storage layer
- **The CLI contract stays** — `shadow find`, `shadow read`, etc. keep their JSON shapes
- **The evidence ledger stays** — `log.md` is a human-readable projection, not a replacement
- **Test suite must keep passing** — every change lands with the full suite green

---

## Migration

There is no `shadow migrate` command, and none is planned. This project is in
active development with no legacy corpora to carry forward — every volume in
this repo speaks OKF v0.2 already. `parseChapterDocument` and
`parseVolumeDocument` hard-fail on a document missing `type` *by design*: a
pre-OKF document is invalid, not a migration candidate. When the OKF
frontmatter fields landed, the fixtures that predated them were rewritten in
place as part of that change — the same way any other breaking fixture-schema
change gets fixed, not via a standing migration tool.

If a future integration needs to onboard a genuinely external, non-Shadow
corpus, that calls for a new tool designed for that job then — not a
resurrection of this section's original `shadow migrate --to-okf` plan.

---

## Success criteria

1. Every chapter has `type`, `status`, `generated`, and optional `verified`/`stale_after`
2. Every volume has `index.md` and `log.md`
3. `shadow lint --okf` passes on a conformant volume
4. An external OKF reader can navigate a Shadow bundle
5. The existing test suite keeps passing
6. `bun run check` is green
