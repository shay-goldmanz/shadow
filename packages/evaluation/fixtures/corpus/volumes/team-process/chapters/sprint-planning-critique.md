---
title: Estimate the unknowns, not the hours
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Running sprint planning — how to size upcoming work and handle
  uncertainty honestly rather than converting every task into a
  false-precision hour count.
not_for: long-term roadmap planning, OKR setting, on-call scheduling
keywords: [sprint planning, estimation, story points, uncertainty, capacity]
confidence: medium
---
Estimating a task in hours produces a number that looks precise and
is usually wrong, because the actual variance in software work comes
from unknowns discovered mid-task, not from typing speed — a task
estimated at "4 hours" that turns out to need a schema change nobody
foresaw was never a 4-hour task with bad luck, it was a task whose
size depended entirely on a question that hadn't been answered yet.

Sizing relative to uncertainty rather than absolute time — "this is
about as unknown as that other task we did last sprint" — captures the
actual source of estimation error instead of hiding it behind false
precision. A task everyone agrees is "large" because nobody has looked
at the third-party API yet should be split into a small spike to
answer that question, and a real estimate, rather than estimated as one
big number that's really a guess wearing a number's clothes.

Planning capacity around 100% of nominal hours guarantees every sprint
either overcommits or requires a rescue at the end, because meetings,
reviews, interruptions, and on-call are not exceptions to capacity,
they are capacity. A sprint that plans for what people can actually
finish, accounting for the work that isn't the sprint's named tasks,
stops being a number the team quietly stops believing in.
