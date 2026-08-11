/**
 * `GET /api/lint?volume=:slug` (`docs/API.md` §Index — "may be slow,
 * model-backed", D14).
 *
 * `runLint` (`@shadow/indexing`) takes a corpus-wide `IndexDocument`, not a
 * volume-scoped one — there is no per-volume lint entry point in that
 * package. This handler scopes the corpus document down to the requested
 * volume before calling it, so checks like discriminability (siblings
 * within a volume) run over the right set of chapters rather than the
 * whole corpus; `stats` is recomputed from the filtered `volumes` array
 * for the same reason `handlers/indexing.ts` recomputes it for reindex.
 * That filtering is response shaping, not a lint decision — every check
 * itself still runs unmodified inside `@shadow/indexing`.
 */

import { toVolumeSlug } from "@shadow/core";
import type { IndexDocument } from "@shadow/indexing";
import { runLint } from "@shadow/indexing";
import type { BunRequest } from "bun";
import type { ApiDeps } from "../deps.ts";
import { IndexNotBuiltError, InvalidRequestError } from "../errors.ts";
import { jsonResponse } from "../http.ts";

export async function getLint(deps: ApiDeps, req: BunRequest<"/api/lint">): Promise<Response> {
  const url = new URL(req.url);
  const volumeParam = url.searchParams.get("volume");
  if (!volumeParam) throw new InvalidRequestError("query parameter 'volume' is required");
  const slug = toVolumeSlug(volumeParam);
  await deps.volumeStore.getVolume(slug); // 404 volume_not_found if it doesn't exist

  const corpus = await deps.volumeStore.readCorpusIndex<IndexDocument>();
  const volumeNode = corpus?.volumes.find((v) => v.volume_id === slug);
  if (!corpus || !volumeNode) throw new IndexNotBuiltError(slug);

  const scoped: IndexDocument = {
    ...corpus,
    volumes: [volumeNode],
    stats: {
      volumes: 1,
      chapters: volumeNode.chapter_count,
      tokens: volumeNode.chapters.reduce((sum, chapter) => sum + chapter.tokens, 0),
    },
  };

  const offline = url.searchParams.get("offline") === "true";
  const report = await runLint(
    scoped,
    { store: deps.volumeStore, port: deps.structuredGenerationPort, missLog: deps.missLog },
    { offline },
  );
  return jsonResponse(report);
}
