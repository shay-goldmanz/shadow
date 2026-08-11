/**
 * The retrieval trace (`docs/INDEXING.md`, "The retrieval trace") and the
 * citation objects it carries. Pure assembly: every citation is built
 * directly from a `ChapterIndexNode`/`SectionIndexNode` already present in
 * the built `IndexDocument` — `content_hash` and `span` were computed by
 * the `Indexer` from the real chapter body at index time
 * (`chapter-index.ts`), never extracted or paraphrased by a model. That is
 * what "hash-pinned citations quoting byte spans of the actual file, never
 * model-extracted prose" means structurally, not just as a policy: there
 * is no code path here that lets prose become a citation's `span`.
 */

import type { Bm25Hit } from "./bm25.ts";
import type { DisagreementSignal } from "./bm25-fallback.ts";
import type { Rejection } from "./round-loop.ts";
import type { ChapterIndexNode, SectionIndexNode, Span } from "./types.ts";

export interface Citation {
  readonly node_id: string;
  readonly path: readonly string[];
  readonly file: string;
  readonly content_hash: string;
  readonly span: Span;
}

/** Build a citation for a whole chapter, straight from its already-computed index fields. */
export function citationForChapter(chapter: ChapterIndexNode): Citation {
  return {
    node_id: chapter.node_id,
    path: chapter.path,
    file: chapter.file,
    content_hash: chapter.content_hash,
    span: chapter.span,
  };
}

/** Build a citation for one section within `chapter` — `path` extends the chapter's path with the section's own heading path so the citation reads as a full breadcrumb. */
export function citationForSection(chapter: ChapterIndexNode, section: SectionIndexNode): Citation {
  return {
    node_id: section.node_id,
    path: [...chapter.path, ...section.heading_path],
    file: chapter.file,
    content_hash: section.content_hash,
    span: section.span,
  };
}

export type RetrievalVerdict =
  | { readonly kind: "sufficient" }
  | { readonly kind: "need-more"; readonly refinedQuery: string }
  | { readonly kind: "not-in-corpus" };

/** One entry of `docs/INDEXING.md`'s trace array. Matches the doc's `step` shapes, plus two steps the doc's example doesn't show but D11a's rules require recording: `bm25-fallback` and `disagreement`, both zero-LLM signals computed by this package rather than the agent. */
export type TraceStep =
  | {
      readonly step: "route";
      readonly considered: readonly string[];
      readonly chose: readonly string[];
      readonly why: string;
    }
  | {
      readonly step: "navigate";
      readonly volume?: string;
      readonly chose: readonly string[];
      readonly rejected: readonly Rejection[];
    }
  | { readonly step: "grade"; readonly verdict: RetrievalVerdict }
  | { readonly step: "bm25-fallback"; readonly query: string; readonly hits: readonly Bm25Hit[] }
  | { readonly step: "disagreement"; readonly signal: DisagreementSignal };

export interface RetrievalTrace {
  readonly query: string;
  readonly rounds: number;
  readonly trace: readonly TraceStep[];
  readonly citations: readonly Citation[];
  readonly verdict: RetrievalVerdict;
}

export interface BuildTraceInput {
  readonly query: string;
  readonly rounds: number;
  readonly steps: readonly TraceStep[];
  readonly citations: readonly Citation[];
  readonly verdict: RetrievalVerdict;
}

/** Assemble the final `RetrievalTrace`. A thin, explicit constructor rather than a bare object literal at each call site, so trace shape has one place to change. */
export function buildTrace(input: BuildTraceInput): RetrievalTrace {
  return {
    query: input.query,
    rounds: input.rounds,
    trace: input.steps,
    citations: input.citations,
    verdict: input.verdict,
  };
}
