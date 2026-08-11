/**
 * `GET /api/volumes/:slug/index`, `POST /api/volumes/:slug/reindex`
 * (`docs/API.md` §Index).
 */

import { toVolumeSlug } from "@shadow/core";
import type { IndexStats, VolumeIndexDocument } from "@shadow/indexing";
import type { BunRequest } from "bun";
import type { ApiDeps } from "../deps.ts";
import { IndexNotBuiltError } from "../errors.ts";
import { jsonResponse } from "../http.ts";

export async function getIndex(
  deps: ApiDeps,
  req: BunRequest<"/api/volumes/:slug/index">,
): Promise<Response> {
  const slug = toVolumeSlug(req.params.slug);
  await deps.volumeStore.getVolume(slug); // 404 volume_not_found if it doesn't exist
  const document = await deps.volumeStore.readIndex<VolumeIndexDocument>(slug);
  if (!document) throw new IndexNotBuiltError(slug);
  return jsonResponse(document);
}

/** Sum a volume node's own chapter tokens — `Indexer.reindex` only returns corpus-wide `IndexStats`, so a volume-scoped view is derived here from its real per-chapter data rather than invented. */
function volumeStatsOf(document: VolumeIndexDocument): IndexStats {
  const tokens = document.volume.chapters.reduce((sum, chapter) => sum + chapter.tokens, 0);
  return { volumes: 1, chapters: document.volume.chapter_count, tokens };
}

export async function reindex(
  deps: ApiDeps,
  req: BunRequest<"/api/volumes/:slug/reindex">,
): Promise<Response> {
  const slug = toVolumeSlug(req.params.slug);
  await deps.volumeStore.getVolume(slug); // 404 volume_not_found if it doesn't exist

  // `Indexer.reindex` rebuilds the whole corpus (D11a: there is no
  // per-volume reindex) and persists both the corpus-wide document and
  // each volume's own scoped view (`VolumeStore.writeIndex`) as a side
  // effect. Re-reading the persisted per-volume view, rather than
  // reconstructing `VolumeIndexDocument`'s shape here by hand, keeps this
  // handler from re-deriving something `@shadow/indexing` already built.
  await deps.indexer.reindex(deps.volumeStore);
  const document = await deps.volumeStore.readIndex<VolumeIndexDocument>(slug);
  if (!document) throw new IndexNotBuiltError(slug);

  return jsonResponse({ index: document, stats: volumeStatsOf(document) });
}
