---
title: Validate on blur, never on keystroke
type: Design Guidance
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Designing form input feedback: when a validation error should
  appear, where the message should sit, and how aggressive the
  feedback timing should be.
not_for: search inputs, live filters, non-blocking preference toggles
keywords: [form, validation, error message, input, blur, feedback timing]
confidence: high
---
Validating an email field on every keystroke means the user sees "invalid
email" while they have typed exactly one character. That is not
feedback, it is noise timed to be maximally discouraging. Validate on
blur — when the user leaves the field — so the message appears once
they have actually finished the thought, and re-validate on every
keystroke only after the field has already failed once, so the error
disappears the instant it's fixed instead of lingering.

The message belongs directly under the field it describes, not
collected in a summary banner at the top of the form. A banner forces
the user to hold "which field was that again" in their head while
scrolling back down to fix it. Inline placement means the fix happens
where the eye already is.

Required-field asterisks are a weaker signal than they used to be
because forms overuse them; stating what's optional, when most fields
are required, communicates faster than marking what's required when
most fields are.
