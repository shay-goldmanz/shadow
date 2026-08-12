---
title: Review the diff, not the author
type: Design Guidance
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Establishing how a team gives and receives code review feedback —
  tone, what's worth blocking on, and how fast a review should turn
  around.
not_for: PR description writing, commit message style, testing strategy
keywords: [code review, feedback, team norms, blocking comment, nitpick]
confidence: medium
---
A review comment phrased as "why did you do it this way" reads as an
accusation regardless of intent; "what happens if this list is empty"
reads as a question about the code. The difference is not politeness
for its own sake — it changes whether the author's next move is to
defend a decision or to actually reconsider it, which is the entire
point of review.

Distinguish blocking comments from nitpicks explicitly, in the comment
itself — a prefix like "nit:" for anything the author is free to
ignore keeps a review from stalling on nine trivial preferences while
the one comment that actually matters gets lost among them. A reviewer
who never marks anything as optional is training authors to treat
every comment as a negotiation.

Review turnaround time matters more than review thoroughness past a
certain point: a review that arrives in twenty minutes with three good
comments beats one that arrives two days later with ten, because the
author has moved on and the context-switch cost of returning to it
erases most of the extra thoroughness's value. A team's real review SLA
is a process decision as consequential as any style guideline in the
review itself.
