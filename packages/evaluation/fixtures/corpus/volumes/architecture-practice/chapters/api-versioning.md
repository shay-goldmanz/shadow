---
title: Version the contract, not the endpoint
type: Design Guidance
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Deciding how a public or internal API signals and manages breaking
  changes over time — URL versioning, header versioning, and
  deprecation policy.
not_for: internal function signatures within one codebase, library semver rules
keywords: [api versioning, breaking change, deprecation, contract, backward compatibility]
confidence: medium
---
Bumping `/v1/` to `/v2/` for every breaking field rename produces a
proliferation of near-identical endpoints that every consumer has to
track independently, and it conflates two different kinds of change
that deserve different treatment: additive changes, which should never
require a version bump at all, and genuinely breaking ones, which need
a clear migration path more than they need a new number.

Additive changes — a new optional field, a new endpoint, a widened
enum — are not breaking if consumers are required to ignore fields
they don't recognize; that requirement has to be stated once, up
front, as a contract rule, not discovered the first time a client
breaks because it validated a response against a closed schema.

For genuinely breaking changes, a deprecation window with a concrete
end date and a machine-readable deprecation signal (a response header,
a field in the payload) does more for consumers than a new version
number alone — a version bump tells them something changed, not what
to do about it or how long they have. The version number is the least
useful part of a versioning policy; the deprecation communication is
the part that actually prevents an outage on the consumer's side.
