/**
 * The honest baseline (T4.2): flat BM25 over chapter title + body text
 * only. No `when_to_use`/`not_for`/`keywords`, no reasoning, no LLM call —
 * this is deliberately what a product with no authored routing metadata
 * and no reasoning-based navigation would do. Reuses `@shadow/indexing`'s
 * already-tested `Bm25Index` (field boosts, k1/b) rather than
 * reimplementing scoring — passing empty strings for the `when_to_use`/
 * `keywords` fields means they contribute zero terms and zero score, which
 * is what makes this an honest "title + body" baseline rather than a
 * relabeled copy of D11a's fielded fallback index.
 *
 * Zero LLM calls by construction — `tokenCost` is always
 * `ZERO_TOKEN_COST`. That is the actual point of comparing it against the
 * tree navigator (D11's claim is economic): this strategy is free and the
 * navigator isn't, so the navigator has to buy back that cost in quality.
 */

import { toVolumeSlug, type VolumeStore } from "@shadow/core";
import { type Bm25Document, Bm25Index, type IndexDocument } from "@shadow/indexing";
import { chapterId } from "../corpus/chapter-id.ts";
import { dedupeChapterIds, type RetrievalStrategy, type StrategyQueryResult } from "./strategy.ts";
import { ZERO_TOKEN_COST } from "./token-tracking.ts";

export interface NaiveBm25StrategyOptions {
  /** How many top-scoring chapters to return. Defaults to `3`, matching the small hit sets the tree navigator typically returns — an apples-to-apples result-set size rather than dumping the whole ranked corpus. */
  readonly topK?: number;
}

export class NaiveBm25Strategy implements RetrievalStrategy {
  readonly name = "naive-bm25";
  readonly description =
    "Flat BM25 over chapter title + body text only — no routing metadata, no reasoning. The honest baseline (docs/PLAN.md T4.2).";

  private indexPromise: Promise<Bm25Index> | undefined;
  private readonly topK: number;

  constructor(
    private readonly store: VolumeStore,
    private readonly document: IndexDocument,
    options: NaiveBm25StrategyOptions = {},
  ) {
    this.topK = options.topK ?? 3;
  }

  async retrieve(query: string): Promise<StrategyQueryResult> {
    const index = await this.getIndex();
    const hits = index
      .score(query)
      .filter((hit) => hit.score > 0)
      .slice(0, this.topK);
    const retrieved = dedupeChapterIds(hits.map((hit) => hit.id));
    return {
      retrieved,
      verdict: retrieved.length === 0 ? "not-in-corpus" : "found",
      tokenCost: ZERO_TOKEN_COST,
    };
  }

  private async getIndex(): Promise<Bm25Index> {
    this.indexPromise ??= this.buildIndex();
    return this.indexPromise;
  }

  private async buildIndex(): Promise<Bm25Index> {
    const docs: Bm25Document[] = [];
    for (const volume of this.document.volumes) {
      const chapters = await this.store.listChapters(toVolumeSlug(volume.volume_id));
      const bodyBySlug = new Map<string, string>(
        chapters.map((chapter) => [chapter.slug, chapter.body]),
      );
      for (const chapterNode of volume.chapters) {
        const body = bodyBySlug.get(chapterNode.slug) ?? "";
        docs.push({
          id: chapterId(volume.volume_id, chapterNode.slug),
          fields: { title: chapterNode.title, when_to_use: "", keywords: "", body },
        });
      }
    }
    return new Bm25Index(docs);
  }
}
