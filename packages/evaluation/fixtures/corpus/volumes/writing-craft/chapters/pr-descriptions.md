---
title: A PR description is a review aid, not a changelog
type: Design Guidance
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Writing the description of a pull request that a human reviewer will
  read before opening the diff, to orient them before they start
  reading code.
not_for: commit message wording, release notes, incident postmortems
keywords: [pull request, PR description, code review, reviewer context]
confidence: high
---
A pull request description's job is to make the reviewer faster and
more accurate, not to document the change for posterity — that is what
the commit messages and the eventual changelog entry are for. A good
description tells the reviewer what to pay the closest attention to
before they open a single file: "the retry logic in the queue consumer
is the risky part; everything else is mechanical renaming."

Include a test plan the reviewer can act on: what was actually run,
what a reviewer could run themselves to confirm the change works,
screenshots for anything visual. A description that just says "tests
pass" answers a question nobody asked; a reviewer wants to know how
confident to be, not that CI is green (they can already see that).

Keep the description honest about what is not done. "Follow-up: this
does not yet handle the offline case, tracked in #482" prevents a
reviewer from approving something they'd have blocked had they assumed
it was complete. A description that oversells scope to get an easier
review is a debt against the next person who assumes it did what it
claimed.
