/**
 * `shadow chapters <volume> [--rank "<task>"]` — the STAGE 3 (NAVIGATE)
 * chapter rows for one volume, either in natural (document) order or
 * BM25-ordered against a task. This is the escape hatch for an agent that
 * already knows which volume it wants (from `shadow volumes`) and would
 * rather browse than run the full `find` round loop.
 */

import { toVolumeSlug, VolumeNotFoundError, type VolumeStore } from "@shadow/core";
import {
  buildFallbackIndex,
  buildNavigatePayload,
  type ChapterIndexRow,
  type Confidence,
  type IndexDocument,
  type VolumeIndexNode,
} from "@shadow/indexing";
import { VolumeLookupError } from "../errors.ts";
import { loadCorpusIndex } from "../loaders.ts";

export interface RankedChapterRow {
  readonly node_id: string;
  readonly title: string;
  readonly when_to_use?: string;
  readonly not_for?: string;
  readonly keywords?: readonly string[];
  readonly tokens: number;
  readonly updated?: string;
  readonly confidence?: Confidence;
  readonly superseded_by?: string;
  /** Present only when `--rank` was given. */
  readonly score?: number;
}

export interface ChaptersResult {
  readonly volume_id: string;
  readonly chapters: readonly RankedChapterRow[];
  readonly next_steps: readonly string[];
}

export interface ChaptersOptions {
  readonly rank?: string;
}

function findVolume(document: IndexDocument, volumeId: string): VolumeIndexNode {
  const volume = document.volumes.find((v) => v.volume_id === volumeId);
  if (!volume) {
    throw new VolumeLookupError(new VolumeNotFoundError(volumeId));
  }
  return volume;
}

async function rankByBm25(
  store: VolumeStore,
  document: IndexDocument,
  volume: VolumeIndexNode,
  rows: readonly ChapterIndexRow[],
  task: string,
): Promise<readonly RankedChapterRow[]> {
  const chapters = await store.listChapters(toVolumeSlug(volume.volume_id));
  const bodyBySlug = new Map<string, string>(chapters.map((c) => [c.slug, c.body]));
  const bodies = new Map<string, string>();
  for (const chapterNode of volume.chapters) {
    const body = bodyBySlug.get(chapterNode.slug);
    if (body !== undefined) {
      bodies.set(chapterNode.node_id, body);
    }
  }
  // Scope the fallback index to this one volume: reuse the document shape
  // buildFallbackIndex expects, but with only this volume's chapters.
  const scoped: IndexDocument = { ...document, volumes: [volume] };
  const index = buildFallbackIndex(scoped, bodies);
  const scoreById = new Map(index.score(task).map((hit) => [hit.id, hit.score]));

  return rows
    .map((row) => ({ ...row, score: scoreById.get(row.node_id) ?? 0 }))
    .toSorted((a, b) => b.score - a.score);
}

function nextSteps(volumeId: string, rows: readonly RankedChapterRow[]): readonly string[] {
  if (rows.length === 0) {
    return [
      `Volume "${volumeId}" has no chapters yet.`,
      "Call `shadow volumes` for other volumes.",
    ];
  }
  const top = rows[0];
  return [
    top
      ? `Call \`shadow read ${top.node_id} [--with-parents]\` to read the top row's body.`
      : "Call `shadow read <node_id> [--with-parents]` to read a chapter's body.",
    "Rows carry `when_to_use`/`not_for` — reason over those before reading a full body.",
  ];
}

export async function runChapters(
  store: VolumeStore,
  volumeId: string,
  options: ChaptersOptions,
): Promise<ChaptersResult> {
  const document = await loadCorpusIndex(store);
  const volume = findVolume(document, volumeId);
  const rows = buildNavigatePayload(document, { volumeIds: [volumeId] }).chapters;

  const chapters = options.rank
    ? await rankByBm25(store, document, volume, rows, options.rank)
    : rows;

  return { volume_id: volumeId, chapters, next_steps: nextSteps(volumeId, chapters) };
}
