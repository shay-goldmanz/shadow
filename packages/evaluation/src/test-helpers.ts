/**
 * Test-only helpers, not part of the public surface (not re-exported from
 * `index.ts`) — matches the pattern in `@shadow/core`/`@shadow/indexing`/
 * `@shadow/model`'s own `test-helpers.ts`.
 *
 * `withTinyCorpus` builds a tiny, in-memory-backed (scratch directory)
 * corpus for strategy/harness unit tests — deliberately separate from
 * `fixtures/corpus` (the real, committed T4.1 corpus), which is reserved
 * for the actual measured baseline so its scores stay comparable across
 * runs. Unit tests that only need to prove plumbing works should never
 * depend on the real fixture corpus's exact content.
 *
 * `expectRejection` matches every other package's own `test-helpers.ts`
 * verbatim: `expect(promise).rejects.toBeInstanceOf(...)` is Bun's
 * documented API, but its matcher methods are typed to return `void` even
 * though the chain must be awaited to actually run — that mismatch trips
 * oxlint's type-aware `await-thenable` rule (D8). `expect.unreachable`
 * (also documented by bun:test) sidesteps it entirely with a plain
 * try/catch.
 */

import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemVolumeStore, toChapterSlug, toVolumeSlug, type VolumeStore } from "@shadow/core";
import { type IndexDocument, StructuralIndexer } from "@shadow/indexing";

type ErrorConstructor<E> = new (...args: any[]) => E;

/** Await `promise`, assert it rejects, and assert the rejection is an instance of `ctor`. Returns the rejection. */
export async function expectRejection<E>(
  promise: Promise<unknown>,
  ctor: ErrorConstructor<E>,
): Promise<E> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ctor);
    return error as E;
  }
  return expect.unreachable(`expected promise to reject with ${ctor.name}, but it resolved`);
}

export interface TinyCorpus {
  readonly store: VolumeStore;
  readonly document: IndexDocument;
}

/**
 * Two volumes, three chapters, with genuine `when_to_use`/`not_for` — small
 * enough to hand-verify in a test, real enough to exercise the actual
 * `Indexer`/`Navigator` machinery rather than hand-constructed fixtures.
 */
export async function withTinyCorpus<T>(fn: (corpus: TinyCorpus) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "shadow-eval-test-"));
  try {
    const store = new FileSystemVolumeStore(root);

    const ui = toVolumeSlug("ui");
    await store.createVolume({
      slug: ui,
      title: "UI",
      frontmatter: { when_to_use: "Designing interfaces.", not_for: "backend code" },
    });
    await store.putChapter(ui, {
      slug: toChapterSlug("density"),
      title: "Table density",
      body: "Linear renders table rows at 32px height, truncating labels aggressively so more rows fit on screen at once.\n",
      frontmatter: {
        when_to_use: "Designing dense tables, lists, and dashboards.",
        not_for: "onboarding flows, empty states",
        keywords: ["density", "table", "row height"],
      },
    });
    await store.putChapter(ui, {
      slug: toChapterSlug("onboarding"),
      title: "Warm onboarding",
      body: "Welcome screens should feel warm, spacious, and low-friction for first-time users completing setup.\n",
      frontmatter: {
        when_to_use: "Designing onboarding and empty states.",
        not_for: "dense data tables",
        keywords: ["onboarding", "welcome", "empty state"],
      },
    });

    const writing = toVolumeSlug("writing");
    await store.createVolume({
      slug: writing,
      title: "Writing",
      frontmatter: { when_to_use: "Writing prose for a reader.", not_for: "UI layout" },
    });
    await store.putChapter(writing, {
      slug: toChapterSlug("one-pagers"),
      title: "One-pagers",
      body: "A one-pager argues a single decision, in one page, for a reader who will not scroll back up.\n",
      frontmatter: {
        when_to_use: "Writing a one-page proposal for a single decision.",
        not_for: "long specs, changelogs",
        keywords: ["one-pager", "proposal"],
      },
    });

    const indexer = new StructuralIndexer({ rootDir: root });
    const { document } = await indexer.build(store);
    return await fn({ store, document });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
