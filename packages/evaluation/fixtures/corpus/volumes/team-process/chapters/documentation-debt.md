---
title: Undocumented is not the same as unimportant
type: Design Guidance
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Deciding how to track and pay down documentation debt across a
  codebase or product, and when missing documentation should block
  shipping versus be tracked for later.
not_for: writing a single README, writing a single one-pager, code review norms
keywords: [documentation debt, tech debt, knowledge, tribal knowledge, onboarding cost]
confidence: medium
---
Documentation debt is invisible on every dashboard that tracks tech
debt, because it doesn't throw an error or show up in a linter — it
shows up months later as a new hire's ramp time, or as the same
question asked in Slack for the fourth time by a fourth different
person, each instance too small to justify fixing the underlying gap
on its own.

The signal worth tracking is not "what's undocumented" — in most
codebases that's everything past a certain depth — but "what gets
asked about repeatedly," because that is the subset where the cost of
staying undocumented is actually accruing versus a corner nobody has
needed to touch in two years and may never need to again. A question
asked three times in a month is worth an hour of documentation; a
question nobody has asked in a year, however undocumented, is not
costing anyone anything yet.

Treating documentation debt as equivalent to code debt — trackable,
prioritizable, sometimes worth blocking a release over — rather than as
a permanent background apology ("we know, we'll get to it") is what
actually gets it paid down. A team that only writes documentation
during onboarding is writing it for exactly one reader at a time,
reactively, instead of once for everyone who'll ask the same question
later.
