---
title: Few good end-to-end tests beat exhaustive unit coverage
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Deciding what to test and at what level — unit, integration, or
  end-to-end — and how much of each a codebase actually needs.
not_for: CI pipeline configuration, choosing a test framework, code review norms
keywords: [testing, unit test, integration test, end-to-end, coverage]
confidence: high
---
A 100% unit-test-coverage number is compatible with a product that
does not actually work, because unit tests mock exactly the boundary
where the real bug lives — the seam between two components each
individually well-tested but wired together wrong. Coverage measures
that a line executed during a test run, not that the behavior a user
depends on was verified.

## What each level is actually for

Unit tests are for logic with real branching complexity worth
enumerating: a parser, a scoring formula, an edge case in date
arithmetic. A unit test around a function that just calls another
function and returns its result verifies that TypeScript's type
checker already verified — it is not free, it has a maintenance cost,
and it is buying almost nothing.

Integration tests earn their cost at a real boundary: does this code
actually talk to that database, that filesystem layout, that external
format, correctly — the class of bug unit tests structurally cannot
catch because they've mocked away the very thing being tested.

End-to-end tests are for the handful of paths that *are* the product —
the critical path a user or an agent actually walks. A few good
end-to-end tests over exhaustive coverage of every path means picking
the two or three journeys whose failure would be a real incident, and
testing those thoroughly, rather than spreading equal effort across
every possible path including ones nobody has ever actually taken.

## The coverage number is a lagging indicator, not a target

Optimizing for the coverage percentage directly produces tests that
exercise a line without asserting anything meaningful about its
behavior — coverage as a target gets gamed the moment it becomes a
target, same as any other metric optimized directly instead of
watched.
