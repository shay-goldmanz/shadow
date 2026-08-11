/**
 * `shadow grep "<terms>"` — the raw BM25 escape hatch (D11a): a fielded
 * keyword search over the whole corpus (chapters and, where they exist,
 * sections), independent of `find`'s route/navigate round loop. This is
 * what catches vocabulary an authored `when_to_use` misses — product
 * names, error codes, people — when an agent already knows roughly what
 * term it's after.
 */

import { toVolumeSlug, type VolumeStore } from "@shadow/core";
import { buildFallbackIndex, flattenIndex, resolveReadContext } from "@shadow/indexing";
import { loadCorpusIndex } from "../loaders.ts";

const DEFAULT_LIMIT = 10;

export interface GrepHit {
  readonly node_id: string;
  readonly title: string;
  readonly path: readonly string[];
  readonly score: number;
}

export interface GrepResult {
  readonly query: string;
  readonly hits: readonly GrepHit[];
  readonly next_steps: readonly string[];
}

async function collectBodies(
  store: VolumeStore,
  document: Awaited<ReturnType<typeof loadCorpusIndex>>,
): Promise<Map<string, string>> {
  const bodies = new Map<string, string>();
  for (const volume of document.volumes) {
    const chapters = await store.listChapters(toVolumeSlug(volume.volume_id));
    const bodyBySlug = new Map<string, string>(chapters.map((c) => [c.slug, c.body]));
    for (const chapterNode of volume.chapters) {
      const body = bodyBySlug.get(chapterNode.slug);
      if (body !== undefined) {
        bodies.set(chapterNode.node_id, body);
      }
    }
  }
  return bodies;
}

function nextSteps(hits: readonly GrepHit[]): readonly string[] {
  if (hits.length === 0) {
    return [
      "No keyword match anywhere in the corpus.",
      'Try `shadow find "<task>"` instead — it reasons over authored when_to_use fields, not just raw terms.',
    ];
  }
  const top = hits[0];
  return [
    top
      ? `Call \`shadow read ${top.node_id}\` to read the top hit's body.`
      : "Call `shadow read <node_id>` to read a hit's body.",
    "`grep` matches on raw keywords only — prefer `shadow find` for normal discovery.",
  ];
}

export async function runGrep(store: VolumeStore, terms: string): Promise<GrepResult> {
  const document = await loadCorpusIndex(store);
  const bodies = await collectBodies(store, document);
  const index = buildFallbackIndex(document, bodies);
  const flat = flattenIndex(document);

  const hits: GrepHit[] = index
    .score(terms)
    .filter((hit) => hit.score > 0)
    .slice(0, DEFAULT_LIMIT)
    .map((hit) => {
      const ctx = resolveReadContext(document, hit.id);
      const title = flat.get(hit.id)?.title ?? hit.id;
      return { node_id: hit.id, title, path: ctx?.heading_path ?? [], score: hit.score };
    });

  return { query: terms, hits, next_steps: nextSteps(hits) };
}
