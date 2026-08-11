/**
 * The `Navigator` port — retrieval over an `IndexDocument`. This is T2.3's
 * scope; nothing here is implemented. It exists so the seam is defined
 * before T2.3 starts, per `ARCHITECTURE.md`'s "Two ports behind one
 * package: `Indexer` (build) and `Navigator` (retrieve), both pluggable
 * so strategies can be swapped and compared."
 *
 * Shape follows `docs/INDEXING.md`'s "Algorithm: retrieval" and "The
 * retrieval trace" sections loosely — kept intentionally minimal so T2.3
 * can refine it without fighting an over-specified contract laid down by
 * a different task.
 */

import type { IndexDocument } from "./types.ts";

export interface NavigateOptions {
  /** Bound at 3 rounds by default (docs/INDEXING.md). */
  readonly rounds?: number;
}

export type RetrievalVerdict =
  | { readonly kind: "sufficient" }
  | { readonly kind: "need-more"; readonly refinedQuery: string }
  | { readonly kind: "not-in-corpus" };

export interface Citation {
  readonly node_id: string;
  readonly path: readonly string[];
  readonly file: string;
  readonly content_hash: string;
  readonly span: { readonly start_byte: number; readonly end_byte: number };
}

export interface RetrievalTrace {
  readonly query: string;
  readonly rounds: number;
  readonly verdict: RetrievalVerdict;
  readonly citations: readonly Citation[];
}

/**
 * Retrieval over a built `IndexDocument`. The calling agent's own
 * inference does the routing/navigating/grading reasoning (D11a) — this
 * port's job is orchestration and the zero-LLM steps (BM25 fallback,
 * ancestor-closure expansion), not the reasoning itself.
 */
export interface Navigator {
  find(document: IndexDocument, query: string, options?: NavigateOptions): Promise<RetrievalTrace>;
}
