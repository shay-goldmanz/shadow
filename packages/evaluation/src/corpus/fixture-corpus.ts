/**
 * The fixed, versioned fixture corpus (T4.1's "baseline first").
 *
 * The corpus lives as plain Markdown + frontmatter under
 * `fixtures/corpus/volumes/*` — the exact on-disk shape
 * `@shadow/core`'s `FileSystemVolumeStore` expects (`VOLUME.md` +
 * `chapters/*.md`), committed to git so scores are comparable across runs
 * (D11a/D17: a moving corpus makes retrieval scores meaningless — D2 makes
 * the same point about research fixtures).
 *
 * `loadFixtureCorpus` never operates on the committed files directly: the
 * indexer mints and writes back a ULID into any chapter missing one (D13),
 * which would otherwise dirty the fixture on every run. Every call copies
 * the fixture tree into a fresh scratch directory first, so the committed
 * corpus is read-only from this package's point of view and a run is free
 * to mutate its own copy (including the indexer's id-minting write-back)
 * without touching git state.
 */

import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemVolumeStore, type VolumeStore } from "@shadow/core";
import type { IndexDocument } from "@shadow/indexing";
import { StructuralIndexer } from "@shadow/indexing";
import { CorpusLoadError } from "../errors.ts";

/** Repo-relative fixture corpus root, resolved from this module's own location so it works regardless of the caller's cwd. */
export const FIXTURE_CORPUS_PATH = join(import.meta.dir, "../../fixtures/corpus");

export interface LoadedCorpus {
  /** A `VolumeStore` backed by a scratch copy of the fixture corpus — safe to mutate (chapter id minting, index writes). */
  readonly store: VolumeStore;
  /** The built corpus-wide index over every volume. */
  readonly document: IndexDocument;
  /** Delete the scratch copy. Always call this when done (a `try`/`finally` in callers). */
  readonly cleanup: () => Promise<void>;
}

/**
 * Copy the fixed fixture corpus into a scratch directory, build a
 * `VolumeStore` over it, and run the structural indexer once.
 *
 * @param sourcePath Override for testing against a different fixture tree
 *   (e.g. a tiny corpus in a unit test). Defaults to the committed
 *   `fixtures/corpus`.
 * @throws {CorpusLoadError} if the source directory does not exist or the
 *   copy fails.
 */
export async function loadFixtureCorpus(
  sourcePath: string = FIXTURE_CORPUS_PATH,
): Promise<LoadedCorpus> {
  const volumesDirExists = await stat(join(sourcePath, "volumes"))
    .then((info) => info.isDirectory())
    .catch(() => false);
  if (!volumesDirExists) {
    throw new CorpusLoadError(sourcePath, "no volumes/ directory found — is this a corpus root?");
  }

  const scratchRoot = await mkdtemp(join(tmpdir(), "shadow-eval-corpus-"));
  try {
    await cp(sourcePath, scratchRoot, { recursive: true });
  } catch (cause) {
    await rm(scratchRoot, { recursive: true, force: true });
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new CorpusLoadError(sourcePath, `failed to copy into scratch directory: ${reason}`, {
      cause,
    });
  }

  const store = new FileSystemVolumeStore(scratchRoot);
  const indexer = new StructuralIndexer();
  const { document } = await indexer.reindex(store);

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    await rm(scratchRoot, { recursive: true, force: true });
  };

  return { store, document, cleanup };
}
