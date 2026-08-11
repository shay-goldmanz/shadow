/**
 * `shadow find "<task>" [--json] [--volumes ids] [--visited ids] [--round n] [--none]`
 * — the entry point an agent reaches for unprompted (`docs/ARCHITECTURE.md`:
 * "It runs `shadow` to discover whether a relevant volume exists").
 *
 * **The central architectural point (T2.3, carried through here exactly):**
 * STAGE 2 (ROUTE), STAGE 3 (NAVIGATE) and STAGE 5 (GRADE) are the *calling
 * agent's own inference*, never an LLM call in this package. This command
 * does not implement `NavigationAgent` and imports nothing from
 * `@shadow/model`. Each stage is a *separate CLI invocation*: the agent
 * reads this command's JSON, reasons about it in its own context, and
 * invokes `shadow find` again with flags carrying its decision forward —
 * exactly the "round state threaded through CLI flags" the task describes.
 * `--volumes` carries a STAGE 2 route decision into STAGE 3; `--visited`
 * and `--round` carry `NavigatePayload.visited`/`RoundState.round` across
 * rounds; `--none` carries the agent's own STAGE 5 judgment that a round's
 * candidates matched nothing, which is the one grade outcome this package
 * can act on without reasoning — it triggers the zero-LLM BM25 fallback
 * (D11a) and, if that also finds nothing, an explicit not-in-corpus verdict.
 *
 * What this package decides structurally, with zero LLM calls, matching
 * D11a's "zero-LLM signals" list:
 * - An empty corpus, or a navigate payload with nothing left to show after
 *   `visited` is excluded, is unambiguously not-in-corpus — there is
 *   nothing for the agent to reason over, so no reasoning is skipped by
 *   deciding this ourselves.
 * - `--round` beyond `MAX_ROUNDS` (3) is the same hard stop
 *   `docs/INDEXING.md` specifies ("Bound at 3 rounds").
 * - `--none` triggers BM25 fallback/promotion exactly where D11a places it:
 *   "when navigation returns nothing".
 *
 * Every other judgment — which chapters actually answer the task, whether
 * a round needs a refinement — stays with the calling agent, never here.
 */

import { toVolumeSlug, type VolumeStore } from "@shadow/core";
import {
  ancestorClosure,
  buildFallbackIndex,
  buildNavigatePayload,
  buildRoutePayload,
  type ChapterIndexRow,
  type Citation,
  type IndexDocument,
  MAX_ROUNDS,
  renderOutline,
  resolveReadContext,
  type VolumeManifestRow,
} from "@shadow/indexing";
import { loadCorpusIndex } from "../loaders.ts";
import { appendMiss } from "../miss-log.ts";

export interface FindOptions {
  readonly volumes?: readonly string[];
  readonly visited?: readonly string[];
  readonly round?: number;
  readonly none?: boolean;
}

export interface RouteResult {
  readonly stage: "route";
  readonly query: string;
  readonly volumes: readonly VolumeManifestRow[];
  readonly next_steps: readonly string[];
}

export interface NavigateResult {
  readonly stage: "navigate";
  readonly query: string;
  readonly round: number;
  readonly visited: readonly string[];
  readonly chapters: readonly ChapterIndexRow[];
  readonly next_steps: readonly string[];
}

export interface PromotedResult {
  readonly stage: "promoted";
  readonly query: string;
  readonly node_id: string;
  readonly why: string;
  readonly outline: string;
  readonly citation: Citation;
  readonly next_steps: readonly string[];
}

export interface VerdictResult {
  readonly stage: "verdict";
  readonly query: string;
  readonly verdict: "not-in-corpus";
  readonly next_steps: readonly string[];
}

export type FindResult = RouteResult | NavigateResult | PromotedResult | VerdictResult;

async function buildBodies(
  store: VolumeStore,
  document: IndexDocument,
  volumeIds?: readonly string[],
): Promise<Map<string, string>> {
  const volumeIdSet = volumeIds ? new Set(volumeIds) : undefined;
  const bodies = new Map<string, string>();
  for (const volume of document.volumes) {
    if (volumeIdSet && !volumeIdSet.has(volume.volume_id)) {
      continue;
    }
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

async function notInCorpus(
  root: string,
  query: string,
  reason: "no-match" | "empty-corpus" | "rounds-exhausted",
  round: number | undefined,
  next: readonly string[],
): Promise<VerdictResult> {
  await appendMiss(root, { query, reason, round });
  return { stage: "verdict", query, verdict: "not-in-corpus", next_steps: next };
}

function navigateNextSteps(
  query: string,
  payload: { chapters: readonly ChapterIndexRow[]; round: number; visited: readonly string[] },
): readonly string[] {
  const top = payload.chapters[0];
  const visitedSoFar = [...payload.visited, ...payload.chapters.map((c) => c.node_id)];
  const nextRound = payload.round + 1;
  return [
    `Read each chapter's when_to_use/not_for below and pick the ones that answer "${query}".`,
    top
      ? `Call \`shadow read ${top.node_id} [--with-parents]\` on chapters you choose.`
      : "Call `shadow read <node_id> [--with-parents]` on chapters you choose.",
    nextRound <= MAX_ROUNDS
      ? `If none apply, call \`shadow find "${query}" --visited ${visitedSoFar.join(",")} --none\` to try the BM25 fallback.`
      : `If none apply, call \`shadow find "${query}" --visited ${visitedSoFar.join(",")} --none\` — this is the last round.`,
  ];
}

async function runNavigate(
  store: VolumeStore,
  root: string,
  document: IndexDocument,
  query: string,
  volumeIds: readonly string[] | undefined,
  visited: readonly string[],
  round: number,
  none: boolean,
): Promise<FindResult> {
  const payload = buildNavigatePayload(document, { volumeIds, visited, round });

  if (payload.chapters.length === 0) {
    return notInCorpus(root, query, "no-match", round, [
      "No unvisited chapters remain in this corpus for this task.",
      "This has been logged to the operator's miss log.",
    ]);
  }

  if (none) {
    return runBm25Fallback(store, root, document, query, volumeIds, visited, round);
  }

  return {
    stage: "navigate",
    query,
    round: payload.round,
    visited: payload.visited,
    chapters: payload.chapters,
    next_steps: navigateNextSteps(query, payload),
  };
}

async function runBm25Fallback(
  store: VolumeStore,
  root: string,
  document: IndexDocument,
  query: string,
  volumeIds: readonly string[] | undefined,
  visited: readonly string[],
  round: number,
): Promise<FindResult> {
  const bodies = await buildBodies(store, document, volumeIds);
  const scoped: IndexDocument = volumeIds
    ? { ...document, volumes: document.volumes.filter((v) => volumeIds.includes(v.volume_id)) }
    : document;
  const index = buildFallbackIndex(scoped, bodies);
  const visitedSet = new Set(visited);
  const top = index.score(query).find((hit) => hit.score > 0 && !visitedSet.has(hit.id));

  if (!top) {
    return notInCorpus(root, query, "no-match", round, [
      "Neither routing signals nor a raw keyword match found anything for this task.",
      "This has been logged to the operator's miss log.",
    ]);
  }

  const citation = resolveReadContext(document, top.id);
  const closureIds = ancestorClosure(document, [top.id]);
  const outline = renderOutline(document, closureIds);

  return {
    stage: "promoted",
    query,
    node_id: top.id,
    why: "bm25-fallback: no chapter's when_to_use matched, but this node's own text contains matching terms",
    outline,
    citation: citation
      ? {
          node_id: citation.node_id,
          path: citation.heading_path,
          file: citation.file,
          content_hash: citation.content_hash,
          span: citation.span,
        }
      : {
          node_id: top.id,
          path: [],
          file: "",
          content_hash: "",
          span: { start_byte: 0, end_byte: 0 },
        },
    next_steps: [
      `Call \`shadow read ${top.id}\` to check whether this actually answers "${query}" — the fallback only matched keywords, not authored routing signals.`,
      `If it doesn't, call \`shadow find "${query}" --visited ${[...visited, top.id].join(",")} --none\` to keep looking.`,
    ],
  };
}

export async function runFind(
  store: VolumeStore,
  root: string,
  query: string,
  options: FindOptions,
): Promise<FindResult> {
  const document = await loadCorpusIndex(store);

  if (document.stats.chapters === 0) {
    return notInCorpus(root, query, "empty-corpus", undefined, [
      "No volumes exist yet in this corpus — there is nothing to search.",
      "This has been logged to the operator's miss log.",
    ]);
  }

  const round = options.round ?? 1;
  if (round > MAX_ROUNDS) {
    return notInCorpus(root, query, "rounds-exhausted", round, [
      "The 3-round bound (`docs/INDEXING.md`) has been reached without a sufficient answer.",
      "This has been logged to the operator's miss log.",
    ]);
  }

  const visited = options.visited ?? [];

  // STAGE 2 (ROUTE): only when the agent hasn't already routed, and only
  // when the corpus is large enough that skipping it is wrong (D11a).
  if (!options.volumes && !options.none) {
    const routePayload = buildRoutePayload(document);
    if (!routePayload.skip) {
      return {
        stage: "route",
        query,
        volumes: routePayload.volumes,
        next_steps: [
          "Pick the volume_id(s) whose when_to_use/not_for fit this task.",
          `Call \`shadow find "${query}" --volumes <id1,id2>\` to navigate chapters in the chosen volume(s).`,
        ],
      };
    }
  }

  return runNavigate(
    store,
    root,
    document,
    query,
    options.volumes,
    visited,
    round,
    options.none ?? false,
  );
}
