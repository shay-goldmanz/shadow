---
title: A port is a promise the domain makes to itself
type: Design Guidance
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Deciding whether a piece of infrastructure — storage, an external
  API, an LLM provider — needs an interface boundary, and where
  exactly to draw it.
not_for: UI component composition, database schema design, visual layout
keywords: [ports and adapters, hexagonal architecture, interface, dependency inversion, seam]
confidence: high
---
Not every dependency earns an interface. A port is worth its cost only
when at least one of three things is true: the implementation is
genuinely likely to be swapped (a second storage backend, a second LLM
provider), tests need to run without the real thing (no network, no
API key, no live model), or the boundary is where an invariant the
rest of the system depends on actually gets enforced (auth resolution,
no-API-key guardrails). Wrapping a stable, unswappable dependency in an
interface "for testability" alone usually just adds a layer of
indirection nobody reads through cleanly.

## Where to draw the seam

Draw it at the narrowest point that satisfies the actual need, not at
the package boundary by default. A package that only needs to resolve
one directory path should depend on an interface with one method, not
the full storage port with a dozen — interface segregation, not
convenience. The seam should isolate exactly one risk: a transport, an
auth mechanism, a storage layout — never "everything this package
might one day need from that other package."

## What a fake buys that a mock doesn't

A hand-written in-memory fake that implements the real interface
honestly is worth writing once and sharing across every test that
needs it; a mock that asserts call counts and argument shapes couples
every test to today's implementation detail instead of today's
contract. The fake is a second real implementation with fewer
dependencies, not a recording of expected calls.

A port earns its keep when removing it would require touching every
caller to swap the implementation. If that is not true — if the
"port" has exactly one implementation, no test double, and no
foreseeable second implementation — it is not a port, it is a class
with extra ceremony.
