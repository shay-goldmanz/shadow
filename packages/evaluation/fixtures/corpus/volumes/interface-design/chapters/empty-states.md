---
title: Designing empty states that guide, not apologize
type: Design Guidance
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  A view can be empty — no data yet, a search with no results, a
  freshly created project. Deciding what an empty view should say and
  offer instead of nothing.
not_for: error pages, loading states, dense populated list views
keywords: [empty state, zero data, no results, first-run, call to action]
confidence: high
---
An empty screen is not a failure state and should not read like an
apology. "No items found" with nothing underneath it wastes the one
moment a product has the user's full attention with nothing else
competing for it.

Every empty state answers three questions in the same breath: why is
this empty, what would fill it, and what is the one action that fills
it fastest. A search with no results should say what was searched for
and suggest loosening it. A brand-new project should show what the
first item would look like and put the create action directly under
the explanation, not routed through a separate menu.

Illustration is optional; the action is not. A tasteful empty-state
graphic with no button is decoration. A plain sentence with a working
button is a product. If a team can only afford one, it is always the
button.

Distinguish "empty because nothing has happened yet" from "empty
because a filter hid everything." The second case needs a way back —
"3 items are hidden by your filters" with a one-click reset — never
the same blank canvas as a truly new account, or the user will assume
data was lost.
