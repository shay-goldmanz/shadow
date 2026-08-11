---
title: A changelog is written for the upgrader, not the author
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Writing changelog or release-note entries for a shipped change, read
  by someone deciding whether upgrading affects them.
not_for: commit message wording, pull request descriptions, internal incident writeups
keywords: [changelog, release notes, versioning, breaking change entry]
confidence: medium
---
A changelog entry that says "refactored the auth module" tells the
person upgrading nothing about whether their code will still work
tomorrow. The reader of a changelog is not the author remembering what
they did; it is someone scanning for the one line that affects them,
usually under time pressure, usually right before or right after
upgrading a dependency.

Lead every entry with the user-visible effect, not the internal
mechanism: "API keys created before 2026 must be rotated" beats
"migrated key storage to the new credentials table." If a change is
breaking, say so in the first three words, not buried in the third
sentence — "Breaking: the `format` option now defaults to `json`" lets
a reader stop scanning the moment it doesn't apply to them.

Group entries by what the reader needs to decide, not by internal
category: breaking changes first, then new capabilities, then fixes.
An entry with no user-visible effect — an internal refactor, a test
change — does not belong in the changelog at all, no matter how much
work it took; it belongs in the commit history, for a different
reader entirely.
