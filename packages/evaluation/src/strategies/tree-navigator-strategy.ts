/**
 * Our design (D11/D11a): the tree navigator, agent-as-locator over the
 * authored chapter index. Wraps `@shadow/indexing`'s `ReasoningNavigator`
 * completely unmodified — this strategy adds nothing to the retrieval
 * algorithm itself, only the chapter-id resolution and token-cost
 * bookkeeping this comparison needs.
 *
 * Takes a `NavigationAgent` directly rather than constructing one itself,
 * so the same class drives both the deterministic default test suite
 * (a scripted `NavigationAgent`, never a real model) and the live
 * measurement run (`ModelNavigationAgent` wrapping a real
 * `StructuredGenerationPort`) — determinism/live-mode is the caller's
 * concern, not this strategy's (`docs/PLAN.md` brief: "drive the
 * model-backed stages through @shadow/model's fakes with scripted
 * decisions for the default test suite").
 */

import type { VolumeStore } from "@shadow/core";
import type { IndexDocument, NavigateOptions, NavigationAgent } from "@shadow/indexing";
import { ReasoningNavigator } from "@shadow/indexing";
import { buildNodeToChapterMap, resolveChapterId } from "../corpus/chapter-id.ts";
import { dedupeChapterIds, type RetrievalStrategy, type StrategyQueryResult } from "./strategy.ts";
import { type TokenCostTracker, ZERO_TOKEN_COST } from "./token-tracking.ts";

export interface TreeNavigatorStrategyOptions extends NavigateOptions {
  /**
   * Reads accumulated token cost from this tracker after each query
   * (typically a `MeasuringStructuredGenerationPort` wrapping whatever
   * port backs `agent`). Omit for a scripted `NavigationAgent` that makes
   * no real model calls — cost then correctly reports as
   * `ZERO_TOKEN_COST`, since none was spent.
   */
  readonly costTracker?: TokenCostTracker;
}

export class TreeNavigatorStrategy implements RetrievalStrategy {
  readonly name = "tree-navigator";
  readonly description =
    "ReasoningNavigator over the authored chapter index (when_to_use/not_for/keywords) — Shadow's actual design (D11/D11a).";

  private readonly navigator: ReasoningNavigator;
  private readonly nodeToChapter: ReadonlyMap<string, string>;
  private readonly navigateOptions: NavigateOptions;
  private readonly costTracker: TokenCostTracker | undefined;

  constructor(
    store: VolumeStore,
    private readonly document: IndexDocument,
    agent: NavigationAgent,
    options: TreeNavigatorStrategyOptions = {},
  ) {
    this.navigator = new ReasoningNavigator(store, agent);
    this.nodeToChapter = buildNodeToChapterMap(document);
    this.costTracker = options.costTracker;
    this.navigateOptions = options.rounds !== undefined ? { rounds: options.rounds } : {};
  }

  async retrieve(query: string): Promise<StrategyQueryResult> {
    this.costTracker?.reset();
    const trace = await this.navigator.find(this.document, query, this.navigateOptions);
    const retrieved = dedupeChapterIds(
      trace.citations
        .map((citation) => resolveChapterId(this.nodeToChapter, citation.node_id))
        .filter((chapter): chapter is string => chapter !== undefined),
    );
    return {
      retrieved,
      verdict: trace.verdict.kind === "not-in-corpus" ? "not-in-corpus" : "found",
      tokenCost: this.costTracker?.cost ?? ZERO_TOKEN_COST,
      rounds: trace.rounds,
    };
  }
}
