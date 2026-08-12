---
title: A commit message explains why, the diff explains what
type: Design Guidance
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Writing the commit message for a code change — subject line and
  body — for a change that will be read later by someone running
  `git blame`, not by today's reviewer.
not_for: pull request descriptions, changelog or release-note entries, inline code comments
keywords: [commit message, git, git blame, subject line, rationale]
confidence: high
---
The diff already shows what changed; a commit message that restates it
line by line ("added a null check, updated the import") wastes the one
field version control gives you for information the diff cannot
contain — why the change happened. "Added a null check" tells a future
reader nothing they couldn't get from the diff itself; "guard against
the webhook payload arriving before the session exists, per the retry
storm on 2026-01-09" tells them something they will actually need six
months from now when they're deciding whether it's safe to remove.

Subject lines stay under about 50 characters, written as an imperative
("fix", not "fixed" or "fixes"), because that is what renders cleanly
in `git log --oneline` and in most tools' commit list views. The body,
when there is one, is separated from the subject by a blank line and
explains the reasoning, the constraint that ruled out an obvious
alternative, or a link to the incident or ticket that motivated it.

A commit message is written for `git blame`, months or years later, by
someone who has no memory of today's context and no access to today's
Slack thread. That reader is the actual audience — not the person
about to click merge.
