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

/**
 * T2.8a (found by end-to-end testing): a natural-language query sharing
 * only function words with a chapter — "for", "and", "on", the bare `s`
 * left over from tokenizing the possessive in "Notion's" — still scored
 * above zero and won fallback promotion, returning a weak `promoted` guess
 * instead of an honest miss. Every spurious promotion like that costs the
 * calling agent a verify-and-reject round and pollutes D14's miss log.
 *
 * Small, deterministic, dependency-free — plain English function words
 * plus the single-letter/short remnants `tokenize`'s
 * `[\p{L}\p{N}]+` regex leaves behind when it splits a contraction or
 * possessive on the apostrophe it doesn't match (`"it's"` -> `it`, `s`;
 * `"don't"` -> `don`, `t`; `"I'll"` -> `i`, `ll`; `"we're"` -> `we`, `re`).
 *
 * **Deliberately excluded, checked against this package's own routing
 * vocabulary first:** `not`, `when`, `use`, `for`. All four are ordinary
 * English function words a generic stopword list would strip, but they are
 * load-bearing in this corpus's routing semantics — `when_to_use` and
 * `not_for` are literally named after two of them, and authored frontmatter
 * leans on "for X, not for Y" phrasing throughout `docs/INDEXING.md`'s own
 * examples. Stripping them would weaken exactly the signal BM25 exists to
 * catch as a fallback. `and`/`or` stay in the stoplist: authored
 * `when_to_use`/`not_for` fields consistently list alternatives with commas
 * ("marketing pages, onboarding flows, empty states"), not conjunctions, so
 * losing `and`/`or` costs nothing observed in this corpus's own frontmatter
 * shape.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "had",
  "has",
  "have",
  "having",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "should",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "too",
  "was",
  "were",
  "will",
  "with",
  "would",
  // Contraction/possessive remnants left over once the apostrophe splits a
  // token in two (see doc comment above).
  "d",
  "ll",
  "m",
  "o",
  "re",
  "s",
  "t",
  "ve",
  "y",
]);

function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return matches.filter((term) => !STOPWORDS.has(term));
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
      // `queryTerms` is iterated **with duplicates on purpose** — a repeated
      // query term ("design a dense table with a dense row") contributes to
      // `score` twice, not once. Standard BM25 "query term frequency" (qtf)
      // weighting: repetition in the query is treated as emphasis. Indexed
      // document text is unaffected (`termFreq` above is a true, deduped
      // frequency map) — this is deliberate, not `tokenize` leaking an
      // unfiltered array into a loop that was supposed to dedupe it.
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
