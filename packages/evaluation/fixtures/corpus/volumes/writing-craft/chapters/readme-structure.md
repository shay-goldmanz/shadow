---
title: A README answers three questions in order
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Writing or restructuring the top-level README of a repository, for a
  reader who is deciding whether this project is relevant to them
  before deciding how to use it.
not_for: internal wikis, architecture decision records, one-pagers proposing a new decision
keywords: [README, documentation, repository, getting started]
confidence: medium
---
A README that opens with an install command has skipped a question
the reader was still asking: what is this, and is it for me? The three
questions, in order, are what does this do, is it for me, and how do I
start — and a README that answers them out of order makes a reader who
hasn't decided "is it for me" yet scroll past setup instructions they
don't yet know they need.

One sentence for what it does, written for someone who has never heard
of the project — not the internal shorthand the team uses in Slack.
One short paragraph or a bullet list for who it's for and what problem
it solves, so a reader can bail out fast if it's the wrong tool rather
than discovering that after installing it. Only then, the getting
started section: the shortest path from a clean checkout to something
visibly working, not the exhaustive configuration reference — that
belongs in its own document, linked, not inlined.

A README's length should be inversely proportional to how often
someone lands on it having already decided to use the project. A
public open-source README earns more up-front persuasion; an internal
service's README can assume the reader already knows why it exists and
should get to setup in two lines.
