---
title: A postmortem is blameless and still names causes
type: Design Guidance
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Running or writing up a postmortem after a production incident —
  what belongs in the document and how to keep it blameless without
  becoming vague.
not_for: day-to-day bug triage, feature retrospectives with no incident, on-call scheduling
keywords: [postmortem, incident, blameless, root cause, timeline]
confidence: high
---
Blameless does not mean anonymous or vague — "a deploy caused an
outage" with no further detail protects no one and teaches nothing; "a
migration was deployed without a rollback plan, and the on-call
engineer had no documented way to reverse it" names the actual gap
without naming the person, which is the distinction that matters. The
target of a postmortem is the system and the process, never the
individual who happened to be at the keyboard.

A useful postmortem has a timeline built from evidence — logs,
dashboards, deploy timestamps — not from memory reconstructed after the
fact, because memory reconstructed under the stress of an incident is
reliably wrong about ordering and duration. The timeline should include
the moment detection happened and the moment the fix was confirmed, not
just start and end of user impact, because the gap between "impact
started" and "we noticed" is usually the biggest opportunity for
improvement in the whole incident.

Action items need an owner and a date, not a bullet list of good
intentions — "improve monitoring" with no owner is where postmortem
action items go to be forgotten. Every action item should also state
what specifically would have made this incident shorter or impossible
had it already existed, so its priority can be judged against other
work honestly instead of by how recently the incident happened.
