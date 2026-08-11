---
title: How Linear handles information density
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Designing list views, tables, dashboards — any screen with many rows.
  Choosing between density and whitespace. Deciding what metadata
  belongs inline versus revealed on hover.
not_for: marketing pages, onboarding flows, empty states, mobile-first layouts
keywords: [density, list view, table, row height, hover, Linear]
confidence: high
---
Linear renders a table row at 32px, not 48px. That is the single
decision most products get wrong: they treat every row like a card,
padding it for a photograph that will never be there. A row of text
does not need breathing room proportional to a marketing hero image.

## Row height is a budget, not a preference

Every extra pixel of row height is a pixel not spent showing another
row. At 32px, a 1080px viewport shows about 30 rows without scrolling;
at 48px, it shows 20. For a list a user scans dozens of times a day,
that difference compounds into real time lost to scrolling. Pick a row
height by asking how many rows a working session needs visible at
once, then hold every row to that height regardless of content length.

## Truncation rules

Truncate aggressively and trust the user to expand. A truncated label
with a tooltip on hover costs nothing; a table that wraps to two lines
per row costs a third of your density budget for a caption. The
exception is the primary identifying column — the thing the user
actually scans for — which should truncate last and widest.

## What belongs inline versus on hover

Inline: anything the user needs to make a same-screen decision without
extra input — status, owner, due date. On hover or on a secondary
click: anything diagnostic — created-by, last-modified timestamp, an
internal ID. The test is not "is this useful" (everything is useful to
someone) but "does withholding it change what the user does right
now." If not, it can wait for a hover.

Density is not the absence of whitespace. It is whitespace spent on
the boundaries between rows and columns instead of inside them —
enough to separate, never enough to pad.
