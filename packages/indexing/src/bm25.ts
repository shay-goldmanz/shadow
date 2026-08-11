/**
 * Fielded BM25 (`docs/INDEXING.md`, step 4 of `build_index`).
 *
 * Per D11a, this is deliberately **not** on the default query path — at
 * our scale (1-20 volumes, ~100 chapters) the calling agent reads the
 * full chapter index directly. BM25 exists as a fallback when navigation
 * returns nothing, and as a disagreement/routing-quality signal. Because
 * of that, it is not embedded in `index.json` (which stays a lean
 * structure-only payload with no body text — "never put body text in a
 * structure payload"); it is a standalone, ~150-line, dependency-free
 * module that `@shadow/indexing`'s future `Navigator` (T2.3) builds
 * on-the-fly from chapter/section text it already has via `VolumeStore`.
 *
 * Fielded scoring: title x3, when_to_use x3, keywords x3, body x1,
 * k1=1.2, b=0.75. Implemented as the standard BM25F approximation: each
 * field's term frequency and length are boost-weighted before being
 * combined into a single classic-BM25 computation, rather than a full
 * per-field IDF/per-field-b model — the simpler form is what "~150 lines,
 * no dependencies" implies, and is sufficient for a fallback/disagreement
 * signal rather than a primary ranker.
 */

export interface Bm25Fields {
  readonly title: string;
  readonly when_to_use: string;
  readonly keywords: string;
  readonly body: string;
}

export interface Bm25Document {
  readonly id: string;
  readonly fields: Bm25Fields;
}

export interface Bm25Hit {
  readonly id: string;
  readonly score: number;
}

export const BM25_FIELD_BOOSTS: Readonly<Record<keyof Bm25Fields, number>> = {
  title: 3,
  when_to_use: 3,
  keywords: 3,
  body: 1,
};

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

const FIELD_NAMES: ReadonlyArray<keyof Bm25Fields> = ["title", "when_to_use", "keywords", "body"];

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return matches ?? [];
}

interface DocEntry {
  readonly id: string;
  readonly termFreq: ReadonlyMap<string, number>; // boost-weighted term frequency
  readonly length: number; // boost-weighted document length
}

/**
 * A built BM25 index over a fixed document set. Construction does the
 * O(corpus) tokenization/statistics work once; `score` is then O(query
 * terms x postings) per call.
 */
export class Bm25Index {
  private readonly docs: readonly DocEntry[];
  private readonly documentFrequency: ReadonlyMap<string, number>;
  private readonly averageLength: number;

  constructor(documents: readonly Bm25Document[]) {
    const docs: DocEntry[] = [];
    const documentFrequency = new Map<string, number>();
    let totalLength = 0;

    for (const document of documents) {
      const termFreq = new Map<string, number>();
      let length = 0;
      for (const field of FIELD_NAMES) {
        const boost = BM25_FIELD_BOOSTS[field];
        const terms = tokenize(document.fields[field]);
        length += boost * terms.length;
        for (const term of terms) {
          termFreq.set(term, (termFreq.get(term) ?? 0) + boost);
        }
      }
      for (const term of termFreq.keys()) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
      totalLength += length;
      docs.push({ id: document.id, termFreq, length });
    }

    this.docs = docs;
    this.documentFrequency = documentFrequency;
    this.averageLength = docs.length > 0 ? totalLength / docs.length : 0;
  }

  /** Score every document in the corpus against `query`, sorted by descending score (ties broken by document order). */
  score(query: string): Bm25Hit[] {
    const queryTerms = tokenize(query);
    const n = this.docs.length;
    const idf = new Map<string, number>();
    for (const term of queryTerms) {
      if (idf.has(term)) {
        continue;
      }
      const df = this.documentFrequency.get(term) ?? 0;
      idf.set(term, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
    }

    const hits: Bm25Hit[] = this.docs.map((doc) => {
      let score = 0;
      const lengthNorm =
        1 - BM25_B + BM25_B * (this.averageLength === 0 ? 0 : doc.length / this.averageLength);
      for (const term of queryTerms) {
        const tf = doc.termFreq.get(term) ?? 0;
        if (tf === 0) {
          continue;
        }
        const termIdf = idf.get(term) ?? 0;
        score += (termIdf * (tf * (BM25_K1 + 1))) / (tf + BM25_K1 * lengthNorm);
      }
      return { id: doc.id, score };
    });

    return hits.toSorted((a, b) => b.score - a.score);
  }
}
