# Evidence modal: show the exact cited excerpt

## Problem

Clicking a citation's evidence link opens `SnapshotDialog`, which fetches the
full source snapshot and dumps it verbatim into a `<pre>` block
(`packages/web/src/components/SnapshotDialog.tsx:147`). There is no
indication of where in that text the cited sentence actually is — the reader
has to read or search the whole snapshot themselves. This defeats the
purpose of an "evidence" view: it should show the evidence, not just the
haystack it's buried in.

The data needed to fix this already exists and is already shipped to the
client, unused:

- Each `EvidenceSpan` (`packages/evidence/src/types.ts:125-132`) carries a
  `TextQuoteSelector` (`exact`, optional `prefix`/`suffix`, optional
  `refinedBy: { start, end }` offsets) and an `anchorStatus` of `anchored`,
  `anchored-fuzzy`, or `orphaned`.
- Both fields are computed once, at claim-write time, in
  `packages/agent/src/evidence-binding.ts:72-95` (which calls
  `resolveSelector` in `packages/evidence/src/anchoring.ts:269-321`) and
  persisted on the span.
- `packages/api/src/handlers/chapters.ts:41-56` returns claims — and their
  evidence spans — unmodified, so `anchorStatus` and `refinedBy` are already
  present in the API response.
- `ChapterPage.tsx:185-193`'s `onCiteClick` currently only reads
  `span.sourceId`/`span.snapshotHash` off the evidence span when building a
  `SnapshotRequest`, ignoring `selector` and `anchorStatus` entirely.

So this is a client-only change: thread the selector and anchor status
through, and use them to render something more useful than a raw blob.

## Design

### Data flow

`SnapshotRequest`'s `"sourced"` variant (`SnapshotDialog.tsx:14-20`) gains
two fields:

```ts
| {
    readonly kind: "sourced";
    readonly label: string;
    readonly sourceId: string;
    readonly snapshotHash: string;
    readonly selector: TextQuoteSelector;
    readonly anchorStatus: EvidenceSpan["anchorStatus"];
  }
```

`ChapterPage.tsx`'s `onCiteClick` populates these directly from
`claim.evidence[0]` — no new fetch. `SnapshotDialog` still fetches the full
snapshot text and source metadata exactly as it does today, in parallel;
only the rendering changes.

### Rendering, by `anchorStatus`

**`anchored`** (exact offset match):
Once the snapshot text loads, slice the excerpt using
`selector.refinedBy.start`/`end` (fall back to a plain
`text.indexOf(selector.exact)` scan only if `refinedBy` is missing — it
shouldn't be, but the type allows it). Trim to a bounded window around the
match — up to ~150 characters of surrounding text on each side, cut at a
word boundary — and render:

```
…‹prefix trim› ⟦highlighted exact⟧ ‹suffix trim›…
```

Header shows the source title/meta as today, no badge.

**`anchored-fuzzy`** (approximate match): identical excerpt rendering, plus
an amber badge next to the source meta line: `≈ approximate`. The badge is
the only cue — no inline warning text — since the underlying claim is still
useful and shouldn't read as broken.

**`orphaned`** (quote not found in current snapshot): skip offset-based
slicing entirely — there's nothing to trust. Render `selector.exact`
(bracketed by `selector.prefix`/`selector.suffix` if present) as plain,
unhighlighted text. Header shows a red badge: `⚠ not found`. The "show full
source" action (see below) is relabeled "View full source anyway" for this
state, since there's no location to scroll/highlight to — it's a plain
unhighlighted dump, offered as a fallback rather than a confirmation.

**`derived`** claims (D19 synthesis, no own source): unchanged, still
render the existing "supports" list. None of the above applies.

### "Show full source" expand

Collapsed by default, directly under the excerpt. Expanding reveals the full
snapshot text (today's `<pre>` view), auto-scrolled to and highlighting the
same span, for readers who want full-document context. For `orphaned`, this
still expands to the full raw text, just with no highlight/scroll (nothing
to point at) — hence the "anyway" wording. Collapses back to the excerpt
view on dialog close; no state persisted across opens.

### Visual cues (confirmed via mockup)

Anchor status is communicated as a small badge next to the source title/meta
line in the dialog header — not an inline banner or note. Rationale from
review: a badge is compact and reads proportionate to severity (amber pill
for fuzzy doesn't feel alarm-y for what's still a usable citation; red pill
for orphaned is distinct enough to flag the fallback state) without
dominating the excerpt itself.

## Out of scope

- Client-side re-anchoring/fuzzy-matching logic — `refinedBy` is already
  computed and persisted server-side; the client only ever reads it.
- Changes to `anchoring.ts` or `evidence-binding.ts` themselves.
- Persisting the expand/collapse state across dialog opens or sessions.
