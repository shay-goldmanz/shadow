---
title: A feature flag is a temporary fork, not a permanent if
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Deciding whether to gate a change behind a feature flag, and how
  long a flag is allowed to stay in the codebase before it must be
  removed.
not_for: A/B testing statistics and sample sizing, general ops configuration management
keywords: [feature flag, rollout, toggle, flag debt, kill switch]
confidence: medium
---
A feature flag that has been in the codebase for a year, still checked
in eleven places, is not a feature flag anymore — it is an
undocumented second code path that nobody remembers is optional. Every
flag should be created with an explicit removal condition: at 100%
rollout with no incidents for two weeks, or the experiment concluded,
whichever gate applies, and a flag with no such condition attached at
creation time tends to never get one attached later either.

Two different jobs get lumped under "feature flag" and should be kept
distinct in how they're built: a rollout flag, meant to reach 100% and
then delete itself from the code, and a kill switch, meant to persist
indefinitely as an operational safety valve. Writing a rollout flag as
if it might live forever — deeply threading the check through many
call sites instead of branching once at the top — makes the eventual
cleanup far more expensive than the flag was ever worth.

The cost of a flag is not the conditional itself; it is the
combinatorial testing surface it adds — every flag doubles the number
of states the system can be in, and two live flags together already
means four states, most of which nobody explicitly tests.
