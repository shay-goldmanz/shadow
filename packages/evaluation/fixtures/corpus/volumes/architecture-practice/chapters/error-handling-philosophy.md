---
title: Typed errors over string matching
type: Design Guidance
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Designing how a codebase represents and propagates failure —
  exception hierarchies, typed error classes, and whether a caller
  should ever branch on an error message string.
not_for: user-facing error copy and wording, retry and backoff policy tuning
keywords: [error handling, exceptions, typed errors, error hierarchy]
confidence: high
---
Catching an error and branching on `error.message.includes("not found")`
is a promise that nobody will ever reword that message — and someone
always will, usually while fixing an unrelated typo, breaking a branch
of logic three call sites away with no compiler warning. A typed error
hierarchy, checked with `instanceof`, survives a message rewording
completely unchanged, because the message was never load-bearing to
begin with.

Every error a package throws deliberately should be its own class,
named for the specific failure, carrying whatever structured fields a
caller needs to react correctly — the slug that wasn't found, the field
that failed validation — rather than a generic `Error` with details
interpolated into a string a caller would have to parse back out.

Not every failure needs a typed class. Truly unexpected failures — a
bug, a violated invariant — should propagate as a plain `Error` (or
crash) rather than being wrapped in a typed class that implies the
caller has a reasonable way to handle it. Typed errors are for
failures a caller can meaningfully recover from or report specifically;
wrapping everything, including the unrecoverable cases, in tidy typed
classes just teaches callers to write `catch` blocks that swallow bugs
alongside genuine, recoverable failures.
