---
title: Error messages tell the user what to do next
type: Design Guidance
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Writing the text shown to a user when something goes wrong in a
  product: validation failures, failed requests, permission denials,
  and payment declines.
not_for: internal logs, stack traces shown to engineers, commit messages
keywords: [error message, UX writing, copy, permission denied, failed request]
confidence: high
---
"Something went wrong" is not an error message, it is a shrug. A user
who sees it learns nothing about whether to retry, wait, or give up
and email support. Every error message answers two questions: what
happened, in terms the user recognizes (not an HTTP status code or an
internal exception name), and what they can do about it right now.

"Your card was declined by your bank — try a different card or contact
your bank" is a complete error message: it names the actual cause,
rules out the product as the source of the problem, and gives a next
action. "Payment failed: error 402" answers neither question and sends
the anxious user straight to a support ticket that a better sentence
would have prevented.

Never blame the user in the message even when the user caused the
problem. "Invalid password" reads as an accusation; "that password
doesn't match — reset it or try again" reads as help. For permission
errors, say what permission is missing and, if possible, who can grant
it — "ask an admin to enable billing access" is actionable; "access
denied" is a dead end.
