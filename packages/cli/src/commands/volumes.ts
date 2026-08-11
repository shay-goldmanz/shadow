/**
 * `shadow volumes` — the volume manifest (~150 tok/volume, `docs/INDEXING.md`
 * STAGE 2's row budget). The entry point for an agent that hasn't yet
 * narrowed down which volume (if any) applies — always lists every volume
 * regardless of corpus size, unlike `find`'s STAGE 2 which skips routing
 * under `CHAPTER_INDEX_THRESHOLD`.
 */

import type { VolumeStore } from "@shadow/core";
import type { IndexDocument, VolumeIndexNode } from "@shadow/indexing";
import { loadCorpusIndex } from "../loaders.ts";

export interface VolumeManifestRow {
  readonly volume_id: string;
  readonly title: string;
  readonly when_to_use?: string;
  readonly not_for?: string;
  readonly keywords?: readonly string[];
  readonly chapter_count: number;
}

export interface VolumesResult {
  readonly volumes: readonly VolumeManifestRow[];
  readonly next_steps: readonly string[];
}

function toManifestRow(volume: VolumeIndexNode): VolumeManifestRow {
  return {
    volume_id: volume.volume_id,
    title: volume.title,
    when_to_use: volume.when_to_use,
    not_for: volume.not_for,
    keywords: volume.keywords,
    chapter_count: volume.chapter_count,
  };
}

function nextSteps(document: IndexDocument): readonly string[] {
  if (document.volumes.length === 0) {
    return [
      "No volumes exist yet in this corpus.",
      "Nothing for `shadow find` to search — there is no volume for any task right now.",
    ];
  }
  const first = document.volumes[0];
  return [
    first
      ? `Call \`shadow chapters ${first.volume_id}\` to see that volume's chapters.`
      : "Call `shadow chapters <volume_id>` to see a volume's chapters.",
    'Or call `shadow find "<task>"` to search across every volume at once.',
  ];
}

export async function runVolumes(store: VolumeStore): Promise<VolumesResult> {
  const document = await loadCorpusIndex(store);
  return { volumes: document.volumes.map(toManifestRow), next_steps: nextSteps(document) };
}
