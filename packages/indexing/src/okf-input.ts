/**
 * Input construction for `shadow lint --okf` — the only place I/O happens
 * for the OKF v0.2 conformance check (`lint-okf.ts`'s `checkOkfConformance`
 * stays pure: input bag in, findings out).
 *
 * Two pure record mappers turn already-loaded domain data into the
 * `OkfChapterRecord[]` / `OkfVolumeRecord[]` shapes `checkOkfConformance`
 * consumes: node identity (`node_id`, `slug`, `title`, `type`,
 * `attestedComputation`) comes from the built `IndexDocument` (already
 * assembled by `chapter-index.ts`/`volume-index.ts`); the typed OKF fields
 * that never made it into the index (`status`, `generated`, `verified`,
 * `stale_after`) come from `@shadow/core`'s `Chapter`/`Volume` domain
 * objects, which the caller loads via `VolumeStore.listChapters` /
 * `listVolumes`.
 *
 * The one I/O function, `loadOkfBundleArtifacts`, inspects the bundle-root
 * `index.md` (OKF §8, §12: must declare `okf_version` in its YAML
 * frontmatter) and `log.md` (OKF §9: must exist) that `StructuralIndexer`
 * writes on every reindex (see `indexer.ts`). It never throws — a missing
 * or malformed file is reported as `false`, exactly like `checkOkfConformance`
 * expects to consume it (as findings, not exceptions).
 */

import type { Chapter, Volume } from "@shadow/core";
import { join } from "node:path";
import type { OkfBundleArtifacts, OkfChapterRecord, OkfVolumeRecord } from "./lint-okf.ts";
import type { IndexDocument } from "./types.ts";

// Matches a leading `---\n...\n---` block; the rest of the file is ignored.
// Mirrors `@shadow/core`'s `FRONTMATTER_PATTERN` (not exported publicly,
// so duplicated here rather than reached into that package's internals) —
// deliberately narrow: this only ever needs to know whether the block
// parses as YAML and carries an `okf_version` key, never the rest of the
// document's shape.
const FRONTMATTER_PATTERN = /^---\r?\n((?:[\s\S]*?\r?\n)?)---\r?\n?/;

/**
 * Pure mapper: build `OkfChapterRecord`s for every chapter node in
 * `document`, pulling identity fields (`node_id`, `title`, `type`,
 * `attestedComputation`) from the index and typed OKF fields (`status`,
 * `generated`, `verified`, `stale_after`) from the matching `Chapter`
 * domain object, matched by slug within each volume.
 *
 * A chapter node with no matching entry in `chaptersByVolume` (index and
 * store disagree — should not happen against a freshly built index, but
 * this stays defensive rather than throwing) is skipped.
 */
export function okfChapterRecordsFrom(
  document: IndexDocument,
  chaptersByVolume: ReadonlyMap<string, readonly Chapter[]>,
): readonly OkfChapterRecord[] {
  const records: OkfChapterRecord[] = [];

  for (const volume of document.volumes) {
    const chapters = chaptersByVolume.get(volume.volume_id) ?? [];
    const bySlug = new Map<string, Chapter>(chapters.map((chapter) => [chapter.slug, chapter]));

    for (const node of volume.chapters) {
      const chapter = bySlug.get(node.slug);
      if (!chapter) continue;

      records.push({
        slug: node.slug,
        node_id: node.node_id,
        title: node.title,
        type: node.type,
        status: chapter.status,
        generated: { by: chapter.generated.by, at: chapter.generated.at.toISOString() },
        verified: chapter.verified.map((v) => ({ by: v.by, at: v.at.toISOString() })),
        stale_after: chapter.staleAfter ? chapter.staleAfter.toISOString().slice(0, 10) : undefined,
        attestedComputation: node.attestedComputation,
      });
    }
  }

  return records;
}

/**
 * Pure mapper: build `OkfVolumeRecord`s for every volume node in
 * `document`, pulling `volume_id` from the index and `title`/`type` from
 * the matching `Volume` domain object, matched by slug.
 *
 * A volume node with no matching entry in `volumes` is skipped (same
 * defensive posture as `okfChapterRecordsFrom`).
 */
export function okfVolumeRecordsFrom(
  document: IndexDocument,
  volumes: readonly Volume[],
): readonly OkfVolumeRecord[] {
  const bySlug = new Map<string, Volume>(volumes.map((volume) => [volume.slug, volume]));
  const records: OkfVolumeRecord[] = [];

  for (const node of document.volumes) {
    const volume = bySlug.get(node.volume_id);
    if (!volume) continue;

    records.push({
      volume_id: node.volume_id,
      title: volume.title,
      type: volume.type,
    });
  }

  return records;
}

/** Whether `indexMdPath` exists and its leading YAML frontmatter block declares an `okf_version` key (OKF §8, §12). Never throws. */
async function declaresOkfVersion(indexMdPath: string): Promise<boolean> {
  const file = Bun.file(indexMdPath);
  if (!(await file.exists())) {
    return false;
  }

  try {
    const raw = await file.text();
    const match = FRONTMATTER_PATTERN.exec(raw);
    if (!match) {
      return false;
    }
    const parsed = Bun.YAML.parse(match[1] ?? "");
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "okf_version" in parsed
    );
  } catch {
    return false;
  }
}

/**
 * The only I/O function in this module: read the bundle-root `index.md` and
 * `log.md` under `rootDir` and report whether each carries the artifact
 * `checkOkfConformance` requires (OKF §8/§9/§12). Missing or malformed
 * files are reported as `false`, never thrown.
 */
export async function loadOkfBundleArtifacts(rootDir: string): Promise<OkfBundleArtifacts> {
  const rootIndexOkfVersion = await declaresOkfVersion(join(rootDir, "index.md"));
  const logExists = await Bun.file(join(rootDir, "log.md")).exists();
  return { rootIndexOkfVersion, logExists };
}
