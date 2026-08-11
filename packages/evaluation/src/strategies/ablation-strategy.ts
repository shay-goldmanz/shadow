/**
 * The ablation (T4.2) — the most informative measurement in this package.
 *
 * Isolates whether *authored routing metadata* (`when_to_use`/`not_for`) is
 * what earns the tree navigator's result, or whether the tree structure
 * plus reasoning alone accounts for it. Everything else about the pipeline
 * is held constant: same `ReasoningNavigator`, same BM25 fallback, same
 * ancestor-closure expansion, same passage assembly, same round loop, same
 * grading step. The only thing that changes is what STAGE 3 (NAVIGATE)
 * shows the agent to decide with — title + a body excerpt instead of
 * `when_to_use`/`not_for`/`keywords`.
 *
 * **Where the isolation actually lives.** Not in the `IndexDocument` — it
 * is not stripped or mutated. `AblationNavigationAgent.navigate` simply
 * never reads `payload.chapters[].when_to_use` / `.not_for` / `.keywords`;
 * it builds its own prompt from `node_id` + `title` + a body excerpt
 * fetched separately through `VolumeStore`. The agent is structurally
 * incapable of seeing routing metadata, not merely instructed to ignore
 * it — the same "isolate at the boundary, not by convention" reasoning
 * `DECISIONS.md` D23 applies to source provenance.
 *
 * This deliberately breaks `docs/INDEXING.md`'s "never put body text in a
 * structure payload" rule — on purpose, and only here: that rule is a
 * property of the *real* retrieval algorithm being evaluated, and the
 * ablation exists to ask what happens without one of the real algorithm's
 * choices, which requires actually not making that choice for this one
 * comparison arm.
 */

import { toVolumeSlug, type VolumeStore } from "@shadow/core";
import type {
  ChapterIndexRow,
  GradePayload,
  IndexDocument,
  NavigateDecision,
  NavigateOptions,
  NavigatePayload,
  NavigationAgent,
  RetrievalVerdict,
  RouteDecision,
  RoutePayload,
} from "@shadow/indexing";
import { ReasoningNavigator } from "@shadow/indexing";
import type { StructuredGenerationPort } from "@shadow/model";
import { z } from "zod";
import { buildNodeToChapterMap, resolveChapterId } from "../corpus/chapter-id.ts";
import { dedupeChapterIds, type RetrievalStrategy, type StrategyQueryResult } from "./strategy.ts";
import { type TokenCostTracker, ZERO_TOKEN_COST } from "./token-tracking.ts";

/** Body excerpt length fed to the ablation agent in place of `when_to_use`/`not_for` — long enough to carry real topical signal, short enough to keep the payload bounded (`docs/INDEXING.md`'s own routing-row budget, ~120 tokens, is the scale this is meant to stay near). */
export const ABLATION_EXCERPT_CHARS = 600;

async function buildBodyExcerpts(
  store: VolumeStore,
  document: IndexDocument,
): Promise<ReadonlyMap<string, string>> {
  const excerpts = new Map<string, string>();
  for (const volume of document.volumes) {
    const chapters = await store.listChapters(toVolumeSlug(volume.volume_id));
    const bodyBySlug = new Map<string, string>(
      chapters.map((chapter) => [chapter.slug, chapter.body]),
    );
    for (const chapterNode of volume.chapters) {
      const body = bodyBySlug.get(chapterNode.slug);
      if (body !== undefined) {
        excerpts.set(chapterNode.node_id, body.slice(0, ABLATION_EXCERPT_CHARS).trim());
      }
    }
  }
  return excerpts;
}

const navigateSchema = z.object({
  chosen: z.array(z.string()).describe("node_id values of the chapters that best answer the query"),
  rejected: z
    .array(z.object({ node_id: z.string(), why: z.string() }))
    .describe("chapters seriously considered and explicitly ruled out, with a reason each"),
  reasoning: z.string().optional(),
});

const gradeSchema = z.object({
  verdict: z.enum(["sufficient", "need-more", "not-in-corpus"]),
  refinedQuery: z
    .string()
    .optional()
    .describe("required when verdict is need-more: a refined version of the query"),
});

function formatChapterRow(row: ChapterIndexRow, excerpt: string | undefined): string {
  return `- ${row.node_id}: ${row.title}\n  excerpt: ${excerpt ?? "(no excerpt available)"}`;
}

/**
 * A `NavigationAgent` that routes on title + body excerpt only — never
 * `when_to_use`/`not_for`/`keywords`, even though those fields are present
 * on `payload.chapters` (this class simply does not read them). See this
 * module's doc comment for why the isolation lives here rather than in a
 * stripped `IndexDocument`.
 */
export class AblationNavigationAgent implements NavigationAgent {
  constructor(
    private readonly port: StructuredGenerationPort,
    private readonly bodyExcerpts: ReadonlyMap<string, string>,
  ) {}

  async route(_payload: RoutePayload): Promise<RouteDecision> {
    // Never exercised at this corpus's scale (26 <= CHAPTER_INDEX_THRESHOLD
    // = 60, so payloads.ts's shouldSkipRouting keeps STAGE 2 skipped for
    // every strategy) — thrown rather than silently routing on
    // when_to_use/not_for, which would quietly defeat the ablation the
    // moment the corpus grew past the threshold.
    throw new Error(
      "AblationNavigationAgent.route: not implemented — the ablation is only defined for STAGE 3 (NAVIGATE); a corpus large enough to trigger STAGE 2 routing needs its own ablation design",
    );
  }

  async navigate(payload: NavigatePayload): Promise<NavigateDecision> {
    const prompt = payload.chapters
      .map((row) => formatChapterRow(row, this.bodyExcerpts.get(row.node_id)))
      .join("\n\n");
    const { object } = await this.port.generate({
      schema: navigateSchema,
      schemaName: "ablation_navigate_decision",
      system:
        "You are choosing which chapters answer a task, using ONLY each chapter's title and a short excerpt of its body text — no authored applicability metadata (when_to_use/not_for) is available to you. Choose the shallowest set that answers; reject anything that looks related by title but whose excerpt shows it is actually about something else.",
      prompt: `Round ${payload.round}. Chapters:\n${prompt}`,
    });
    return { chosen: object.chosen, rejected: object.rejected, reasoning: object.reasoning };
  }

  async grade(payload: GradePayload): Promise<RetrievalVerdict> {
    // Grading is unaffected by the ablation — it already reasons over real
    // passage text (STAGE 4 is zero-LLM and identical for every strategy),
    // never over when_to_use/not_for, so this step is intentionally
    // identical to the tree navigator's own grading.
    const { object } = await this.port.generate({
      schema: gradeSchema,
      schemaName: "ablation_grade_verdict",
      system:
        "You are grading whether the passages below fully answer the task. Respond not-in-corpus only if nothing relevant was found at all.",
      prompt: `Task: ${payload.query}\n\nOutline:\n${payload.outline}\n\nPassages:\n${payload.passages.map((p) => p.text).join("\n---\n")}`,
    });
    if (object.verdict === "need-more") {
      return { kind: "need-more", refinedQuery: object.refinedQuery ?? payload.query };
    }
    return { kind: object.verdict };
  }
}

export interface AblationStrategyOptions extends NavigateOptions {
  readonly costTracker?: TokenCostTracker;
}

/** Build an `AblationStrategy` bound to a live/fake port — the async body-excerpt fetch means this can't be a plain constructor. */
export async function createAblationStrategy(
  store: VolumeStore,
  document: IndexDocument,
  port: StructuredGenerationPort,
  options: AblationStrategyOptions = {},
): Promise<RetrievalStrategy> {
  const excerpts = await buildBodyExcerpts(store, document);
  const agent = new AblationNavigationAgent(port, excerpts);
  return new AblationStrategy(store, document, agent, options);
}

/**
 * Wraps a pre-built `AblationNavigationAgent` (or, for tests, any scripted
 * `NavigationAgent`) — most callers should use `createAblationStrategy`,
 * which handles the async excerpt fetch. This class stays synchronous to
 * construct so a test can hand it a `ScriptedAgent` directly, matching the
 * pattern `TreeNavigatorStrategy` uses.
 */
export class AblationStrategy implements RetrievalStrategy {
  readonly name = "ablation-no-routing-fields";
  readonly description =
    "ReasoningNavigator with when_to_use/not_for stripped from what the agent sees — routes on title + body excerpt only. Isolates whether authored routing metadata earns its keep (docs/PLAN.md T4.2).";

  private readonly navigator: ReasoningNavigator;
  private readonly nodeToChapter: ReadonlyMap<string, string>;
  private readonly navigateOptions: NavigateOptions;
  private readonly costTracker: TokenCostTracker | undefined;

  constructor(
    store: VolumeStore,
    private readonly document: IndexDocument,
    agent: NavigationAgent,
    options: AblationStrategyOptions = {},
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

// Re-exported so `harness`/`run-eval` callers building a body-excerpt map
// for diagnostics don't need to reach into this module's internals.
export { buildBodyExcerpts as buildAblationBodyExcerpts };
