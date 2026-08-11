---
title: On-call is bounded, or it isn't sustainable
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Designing an on-call rotation — schedule length, escalation policy,
  and how on-call time is compensated or protected.
not_for: incident response runbooks, postmortem writing, sprint capacity planning
keywords: [on-call, rotation, escalation, pager, compensation]
confidence: medium
---
A rotation with no cap on pages per shift will eventually burn out
whoever is on it, regardless of how good the compensation is — the
bound has to be structural (an escalation policy that shares load, a
follow-the-sun handoff for global teams) not just an aspiration written
into a wiki page nobody enforces. If one engineer is consistently
absorbing more pages than the rest of the rotation, that's a signal the
underlying system needs fixing, not that the rotation needs a more
resilient engineer.

A week-long primary rotation is long enough to build real context on
what's currently unstable but long enough to be genuinely exhausting if
the week is bad; many teams land on a shorter primary shift with a
secondary who only escalates, which shares the load without multiplying
the number of people who have to keep their laptop nearby every night.

Escalation policy should be explicit about what justifies waking
someone at 3am versus what waits for business hours — a policy that
treats every alert as page-worthy trains engineers to mute
notifications entirely, which defeats the purpose of paging at all.
Compensation for on-call time, even when nothing pages, acknowledges
that availability itself has a cost distinct from the incidents it
occasionally produces.
