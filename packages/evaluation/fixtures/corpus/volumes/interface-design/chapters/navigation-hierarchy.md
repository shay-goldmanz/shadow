---
title: Flat navigation over deep nesting
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Structuring an app's primary navigation — sidebar versus tabs versus
  a command palette — and deciding how many levels of nesting the
  information architecture should carry.
not_for: in-page table of contents, breadcrumbs within a single document, onboarding sequencing
keywords: [navigation, sidebar, command palette, information architecture, nesting]
confidence: medium
---
Two levels of navigation nesting is the practical ceiling before a
product needs a search-first escape hatch. A sidebar with sections,
each expanding to items, is level two. A sidebar whose items expand to
sub-items that expand again is where users start getting lost and
start asking a colleague "where is that setting" instead of finding it
themselves.

Linear's answer to needing more than two levels was never a third
level — it was the command palette. Cmd-K is not a power-user
convenience bolted on afterward; it is the release valve that lets the
literal navigation tree stay shallow because anything past level two
is reachable by typing instead of clicking through.

Tabs, not a sidebar, are the right shape when the set of destinations
is small, fixed, and mutually exclusive — you are looking at exactly
one of them at a time and that set will not grow. A sidebar is right
when the set is open-ended, hierarchical, or needs to show a badge or
count per item. Picking tabs for an open-ended set is the most common
navigation mistake: the moment item six needs to exist, tabs overflow
and the whole pattern breaks.
