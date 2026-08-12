---
title: A decision record captures why, so it doesn't get re-litigated
type: Design Guidance
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Deciding whether and how to document a significant technical or
  process decision for a future reader who wasn't in the room, so the
  decision doesn't get silently reversed or endlessly re-argued.
not_for: one-pagers proposing a decision before it's made, routine meeting notes
keywords: [decision record, ADR, rationale, context, alternatives considered]
confidence: medium
---
A decision record written after the fact, once everyone already agrees,
tends to record the conclusion and skip the part that actually matters
later: what else was considered, and why it lost. The value of a
decision record six months on is almost entirely in the "why not the
alternative" section — the conclusion alone is indistinguishable from
an opinion with no basis, and a new engineer who wasn't there has no
way to tell whether the constraint that ruled out the obvious answer
still applies.

Not every decision needs a record. The bar is reversal cost: a decision
that would be expensive or awkward to reverse — one that other
decisions get built on top of — earns a record; a decision easily
undone by whoever encounters it next does not, and writing one anyway
just adds noise a reader has to filter through to find the records that
matter.

A record that never gets superseded is either a decision nobody has
revisited or a sign the situation hasn't changed — both plausible, but
a record that's silently gone stale (the constraint that motivated it
no longer holds) is worse than no record, because it actively misleads
the next reader into thinking the reasoning still applies. Superseding
a record explicitly, rather than deleting it, keeps the history of why
things changed intact.
