/**
 * The `Navigator` port and its default implementation: retrieval over a
 * built `IndexDocument` (`docs/INDEXING.md`, "Algorithm: retrieval"; D11a).
 *
 * **The central architectural point:** STAGE 2 (ROUTE), STAGE 3
 * (NAVIGATE) and STAGE 5 (GRADE) are the *calling agent's own inference*,
 * never an LLM call inside this package. `Navigator` is not an agent — it
 * is the machinery that prepares payloads for one (`payloads.ts`) and
 * consumes its decisions (this file), plus the genuinely zero-LLM steps:
 * ancestor-closure expansion (`closure.ts`), passage assembly
 * (`passages.ts`), the round loop (`round-loop.ts`), and the BM25
 * fallback/disagreement signal (`bm25-fallback.ts`).
 *
 * See `NavigationAgent`'s doc comment for exactly how that reasoning
 * boundary is enforced, and how it differs between the CLI (T3.1, out of
 * scope here) and in-process callers like an evaluation harness (T4.2).
 */

import { toChapterSlug, toVolumeSlug, type VolumeStore } from "@shadow/core";
import { type Bm25Hit, Bm25Index } from "./bm25.ts";
import { bm25Fallback, buildFallbackIndex, detectDisagreement } from "./bm25-fallback.ts";
import { toBytes } from "./byte-text.ts";
import { ancestorClosure, renderOutline } from "./closure.ts";
import { assemblePassages, type Passage, type PassageSource } from "./passages.ts";
import {
  buildNavigatePayload,
  buildRoutePayload,
  type NavigatePayload,
  type RoutePayload,
} from "./payloads.ts";
import { readNode, resolveReadContext, type ReadResult } from "./read.ts";
import {
  advanceRound,
  initialRoundState,
  MAX_ROUNDS,
  type NavigateDecision,
  type RoundState,
} from "./round-loop.ts";
import type { Citation, RetrievalTrace, RetrievalVerdict, TraceStep } from "./trace.ts";
import { buildTrace } from "./trace.ts";
import type { IndexDocument } from "./types.ts";

export type { ChapterIndexRow, NavigatePayload, RoutePayload, VolumeManifestRow } from "./payloads.ts";
export type { NavigateDecision, Rejection } from "./round-loop.ts";
export type { Citation, RetrievalTrace, RetrievalVerdict, TraceStep } from "./trace.ts";
export type { ReadResult } from "./read.ts";

export interface NavigateOptions {
  /** Bound at `MAX_ROUNDS` (3) regardless of what is requested here — `docs/INDEXING.md`: "Bound at 3 rounds". A smaller value narrows the bound further. */
  readonly rounds?: number;
}

/** The agent's STAGE 2 (ROUTE) output. */
export interface RouteDecision {
  readonly consideredVolumeIds: readonly string[];
  readonly chosenVolumeIds: readonly string[];
  readonly why: string;
}

/** What the agent sees going into STAGE 5 (GRADE): the rendered outline plus the actual passages read for this round's chosen node_ids, in document order. */
export interface GradePayload {
  readonly query: string;
  readonly round: number;
  readonly outline: string;
  readonly passages: readonly Passage[];
}

/**
 * The external reasoning surface — the "calling agent" of D11a. STAGE 2,
 * 3, and 5 are the agent's own inference, never an LLM call inside this
 * package.
 *
 * In production (T3.1's CLI), each of these stages is a *separate process
 * invocation* driven by an external coding agent reading `shadow`'s JSON
 * output and deciding what to run next — there is no synchronous callback
 * across that boundary, so the CLI does not implement this interface at
 * all. It calls the payload-building functions (`buildRoutePayload`,
 * `buildNavigatePayload`) and `ancestorClosure`/`readNode` directly, one
 * stage per invocation, threading round state through command-line flags
 * exactly the way `NavigatePayload.visited` is designed to be echoed back.
 *
 * `NavigationAgent` exists for **in-process** orchestration instead — an
 * evaluation harness (T4.2) running many golden queries against
 * `ReasoningNavigator.find()` end to end, backed by either a scripted
 * oracle (this package's own tests use exactly that) or a real model call
 * through `@shadow/model`'s structured-generation port (D5 lists
 * "retrieval node selection" as precisely that kind of workload) — never
 * this package itself, which imports neither AI SDK and stays zero-LLM.
 */
export interface NavigationAgent {
  route(payload: RoutePayload): Promise<RouteDecision>;
  navigate(payload: NavigatePayload): Promise<NavigateDecision>;
  grade(payload: GradePayload): Promise<RetrievalVerdict>;
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

function citationFor(document: IndexDocument, nodeId: string): Citation | undefined {
  const ctx = resolveReadContext(document, nodeId);
  if (!ctx) {
    return undefined;
  }
  return { node_id: ctx.node_id, path: ctx.heading_path, file: ctx.file, content_hash: ctx.content_hash, span: ctx.span };
}

/**
 * Default `Navigator`: orchestrates the retrieval algorithm's zero-LLM
 * steps and defers every reasoning stage to an injected `NavigationAgent`.
 * Comparable-by-construction with future strategies (T4.2) since it only
 * depends on the `Navigator` port's single `find` method plus its own
 * constructor dependencies — a `VolumeStore` (for BM25 fallback body text
 * and passage reads) and a `NavigationAgent`.
 */
export class ReasoningNavigator implements Navigator {
  private fallbackIndexPromise: Promise<Bm25Index> | undefined;

  constructor(
    private readonly store: VolumeStore,
    private readonly agent: NavigationAgent,
  ) {}

  async find(document: IndexDocument, query: string, options: NavigateOptions = {}): Promise<RetrievalTrace> {
    this.fallbackIndexPromise = undefined; // fresh corpus body cache per find() call
    const maxRounds = Math.min(options.rounds ?? MAX_ROUNDS, MAX_ROUNDS);
    const steps: TraceStep[] = [];
    const citations: Citation[] = [];

    const volumeIds = await this.route(document, steps);

    let roundState: RoundState = initialRoundState();
    let currentQuery = query;
    let verdict: RetrievalVerdict = { kind: "not-in-corpus" };

    while (roundState.round <= maxRounds) {
      const round = roundState.round;
      const navigatePayload = buildNavigatePayload(document, {
        volumeIds,
        visited: roundState.visited,
        round,
      });
      const decision = await this.agent.navigate(navigatePayload);
      steps.push({
        step: "navigate",
        volume: volumeIds?.length === 1 ? volumeIds[0] : undefined,
        chose: decision.chosen,
        rejected: decision.rejected,
      });

      const chosen = await this.resolveChosen(document, currentQuery, decision, steps);
      roundState = advanceRound(roundState, decision);

      if (chosen.length === 0) {
        verdict = { kind: "not-in-corpus" };
        if (roundState.round > maxRounds) {
          steps.push({ step: "grade", verdict });
          break;
        }
        continue; // nothing this round; try again if a round remains
      }

      for (const nodeId of chosen) {
        const citation = citationFor(document, nodeId);
        if (citation) {
          citations.push(citation);
        }
      }

      const closureIds = ancestorClosure(document, chosen);
      const outline = renderOutline(document, closureIds);
      const passages = await this.buildPassages(document, chosen);

      verdict = await this.agent.grade({ query: currentQuery, round, outline, passages });
      steps.push({ step: "grade", verdict });

      if (verdict.kind === "sufficient" || verdict.kind === "not-in-corpus") {
        break;
      }
      // need-more: refine and try another round, if one remains.
      currentQuery = verdict.refinedQuery;
      if (roundState.round > maxRounds) {
        break; // hard stop (docs/INDEXING.md: "Bound at 3 rounds") — last verdict stands
      }
    }

    return buildTrace({
      query,
      rounds: Math.max(roundState.round - 1, 1),
      steps,
      citations,
      verdict,
    });
  }

  /** STAGE 2 (ROUTE), skipped entirely at ≤60 chapters (`shouldSkipRouting`, D11a) — returns `undefined` volume ids in that case, meaning "every volume". */
  private async route(
    document: IndexDocument,
    steps: TraceStep[],
  ): Promise<readonly string[] | undefined> {
    const payload = buildRoutePayload(document);
    if (payload.skip) {
      return undefined;
    }
    const decision = await this.agent.route(payload);
    steps.push({
      step: "route",
      considered: decision.consideredVolumeIds,
      chose: decision.chosenVolumeIds,
      why: decision.why,
    });
    return decision.chosenVolumeIds;
  }

  /**
   * Resolve this round's actual chosen node_ids: the agent's own
   * selection, or — when navigation returned nothing — the BM25
   * fallback's top hit (D11a). Also runs the disagreement check when the
   * agent *did* choose something, logging (as a trace step, not a side
   * channel) when BM25's independent top pick sits outside the agent's
   * selection.
   */
  private async resolveChosen(
    document: IndexDocument,
    query: string,
    decision: NavigateDecision,
    steps: TraceStep[],
  ): Promise<readonly string[]> {
    if (decision.chosen.length > 0) {
      const hits = await this.scoreFallback(document, query);
      const signal = detectDisagreement(decision.chosen, hits);
      if (signal) {
        steps.push({ step: "disagreement", signal });
      }
      return decision.chosen;
    }

    const hits = await this.scoreFallback(document, query);
    steps.push({ step: "bm25-fallback", query, hits });
    // A zero-score top hit means no query term matched anything at all —
    // promoting it would fabricate a "find" out of noise, not a real
    // fallback signal (same cutoff `detectDisagreement` uses).
    const top = hits[0];
    return top && top.score > 0 ? [top.id] : [];
  }

  private async scoreFallback(document: IndexDocument, query: string): Promise<readonly Bm25Hit[]> {
    const index = await this.getFallbackIndex(document);
    return bm25Fallback(index, query);
  }

  private async getFallbackIndex(document: IndexDocument): Promise<Bm25Index> {
    this.fallbackIndexPromise ??= this.buildFallbackIndex(document);
    return this.fallbackIndexPromise;
  }

  private async buildFallbackIndex(document: IndexDocument): Promise<Bm25Index> {
    const bodies = new Map<string, string>();
    for (const volume of document.volumes) {
      const chapters = await this.store.listChapters(toVolumeSlug(volume.volume_id));
      const bodyBySlug = new Map<string, string>(chapters.map((chapter) => [chapter.slug, chapter.body]));
      for (const chapterNode of volume.chapters) {
        const body = bodyBySlug.get(chapterNode.slug);
        if (body !== undefined) {
          bodies.set(chapterNode.node_id, body);
        }
      }
    }
    return buildFallbackIndex(document, bodies);
  }

  /** STAGE 4's READ half: fetch and slice the real body for every chosen node_id, grouped by chapter and reassembled in document order (`passages.ts`) rather than relevance order. */
  private async buildPassages(
    document: IndexDocument,
    nodeIds: readonly string[],
  ): Promise<readonly Passage[]> {
    const sourcesByChapter = new Map<
      string,
      { readonly volumeId: string; readonly chapterSlug: string; readonly sources: PassageSource[] }
    >();

    for (const nodeId of nodeIds) {
      const ctx = resolveReadContext(document, nodeId);
      if (!ctx) {
        continue;
      }
      const key = `${ctx.volumeId}/${ctx.chapterSlug}`;
      const bucket = sourcesByChapter.get(key) ?? {
        volumeId: ctx.volumeId,
        chapterSlug: ctx.chapterSlug,
        sources: [],
      };
      bucket.sources.push({ node_id: ctx.node_id, heading_path: ctx.heading_path, span: ctx.span });
      sourcesByChapter.set(key, bucket);
    }

    const passages: Passage[] = [];
    for (const bucket of sourcesByChapter.values()) {
      const chapter = await this.store.getChapter(
        toVolumeSlug(bucket.volumeId),
        toChapterSlug(bucket.chapterSlug),
      );
      passages.push(...assemblePassages(toBytes(chapter.body), bucket.sources));
    }
    return passages;
  }

  /** `shadow read <node_id>` for this navigator's own store — a thin instance-bound convenience over the free `readNode` function. */
  async read(document: IndexDocument, nodeId: string): Promise<ReadResult> {
    return readNode(this.store, document, nodeId);
  }
}
