---
title: Package boundaries are enforced, not suggested
createdAt: 2026-01-01T00:00:00.000Z
updatedAt: 2026-01-01T00:00:00.000Z
when_to_use: >
  Structuring a monorepo — what belongs in its own package, how
  ownership boundaries are kept real across many contributors working
  in parallel, and when to split a package versus grow it.
not_for: single-repo project layout inside one package, folder-naming conventions within a package
keywords: [monorepo, workspace, package boundary, ownership, dependency graph]
confidence: medium
---
A monorepo without enforced package boundaries is a single package
with extra folders — anyone can import anything, and the dependency
graph drifts toward a ball of mud exactly as fast as it would in one
giant `src/`. The boundary only means something once something outside
the owning package fails to compile or fails a lint rule for reaching
across it.

Split a package when two things stop changing together: if a change to
storage never requires a change to the chat UI, they were never one
unit of ownership and the shared package was hiding that. Do not split
along org-chart lines that don't match the actual coupling — a package
per team, regardless of how the code actually depends on itself,
recreates the ball of mud with team names on the folders instead of
none at all.

Cross-package imports should only ever reach a package's declared
public surface — its `index.ts` or equivalent — never a deep import
into another package's internals. A public surface is a promise; a
deep import is a bet that the internals won't move, and it will lose
that bet eventually. When multiple contributors work in parallel across
packages, this is the rule that keeps one person's refactor from
silently breaking another's in-flight work.
