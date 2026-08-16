---
title: Skeletons over spinners, past 400ms
type: Design Guidance
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Deciding how a view communicates that it is fetching data: a bare
  spinner, a skeleton screen, or an optimistic render, and how long to
  wait before showing anything at all.
not_for: form submission button feedback, background sync indicators, progress bars for long uploads
keywords: [loading state, skeleton, spinner, latency, perceived performance]
confidence: medium
---
A response that lands under 400ms should show nothing at all — no
spinner, no flash of a loading state. Showing a spinner for 150ms and
then swapping it for content reads as more broken than a slightly
slower page that just appears, because the eye registers two changes
instead of one.

Past 400ms, prefer a skeleton shaped like the content that is coming —
grey blocks where the title, avatar, and rows will render — over a
spinner. A skeleton sets a spatial expectation the user can start
reading before the data arrives; a spinner communicates only "wait,"
with no information about what's coming or how much of the layout will
shift once it does.

Optimistic rendering — showing the result of an action immediately and
reconciling with the server response after — is the right choice only
when the action is very likely to succeed and the failure path is
cheap to reverse visibly (an unsend, a toast with undo). For anything
where failure is common or expensive to unwind, showing a pending
state and waiting for confirmation is more honest than an optimistic
render that has to be quietly rolled back.
