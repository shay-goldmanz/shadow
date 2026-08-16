---
title: A migration that can't roll back isn't done
type: Design Guidance
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Writing or reviewing a database schema migration for a production
  system, including how to sequence a column rename or type change
  safely.
not_for: one-off manual data backfills run by an engineer, local development seed scripts
keywords: [database migration, schema change, rollback, backward compatibility]
confidence: high
---
A migration that adds a `NOT NULL` column with no default to a table
still receiving writes from the currently-deployed code will fail the
moment it runs against production traffic, because the old code is
still inserting rows that don't set that column. Every migration has to
be safe against the code that is running *right now*, not just the
code it will ship alongside — deploys and migrations are not atomic
together, and there is always a window where old code and new schema
coexist.

The safe pattern for a column rename is never a single migration: add
the new column, backfill it, dual-write to both columns until every
reader has moved to the new one, then drop the old column in a later,
separate deploy. Collapsing that into one migration guarantees a
window where either the old or the new code path is reading a column
that doesn't have the data it expects yet.

"Can't roll back" is not just about the down-migration script existing
— a `DROP COLUMN` technically rolls back, but it also silently
destroys any data written to that column in the meantime. A rollback
plan has to account for data written during the forward migration's
lifetime, not just for reversing the schema change itself.
