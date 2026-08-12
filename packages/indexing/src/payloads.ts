/**
 * Payload preparation for STAGE 2 (ROUTE) and STAGE 3 (NAVIGATE) of
 * `docs/INDEXING.md`'s retrieval algorithm.
 *
 * These stages are the *calling agent's* own inference (D11a) — nothing
 * here reasons about a query. This module's whole job is producing the
 * JSON the agent reads and reasoning over what it hands back
 * (`navigator.ts`). Pure and synchronous: given an already-built
 * `IndexDocument`, no filesystem, network, or model involved.
 *
 * **Never put body text in a structure payload** — every row type here is
 * built exclusively from `index.json`'s structural/routing fields, never
 * from chapter or section body content.
 */

import type { Confidence, IndexDocument, VolumeIndexNode } from "./types.ts";

/**
 * At or below this many chapters in the corpus, the agent reads the full
 * flat chapter index directly and STAGE 2 (ROUTE) is skipped entirely
 * (`docs/INDEXING.md`, STAGE 2; D11a). Above it, the agent routes to a
 * subset of volumes first via `buildRoutePayload`.
 */
export const CHAPTER_INDEX_THRESHOLD = 60;

/** `true` when the corpus is small enough that routing should be skipped and the agent goes straight to the full chapter index. */
export function shouldSkipRouting(document: IndexDocument): boolean {
  return document.stats.chapters <= CHAPTER_INDEX_THRESHOLD;
}

/** One volume's manifest row — budgeted at ≤150 tokens (`docs/INDEXING.md`, STAGE 2). No chapter list: that is STAGE 3's payload. */
export interface VolumeManifestRow {
  readonly volume_id: string;
  readonly title: string;
  /** OKF v0.2 concept type (OKF §4.1). */
  readonly type?: string;
  readonly when_to_use?: string;
  readonly not_for?: string;
  readonly keywords?: readonly string[];
  readonly chapter_count: number;
}

export interface RoutePayload {
  readonly stage: "route";
  /**
   * The task being routed. Wired through so an in-process `NavigationAgent`
   * (`lint-model-navigation-agent.ts`) can actually put the task in its
   * prompt — before this field existed, `route`/`navigate` prompts were
   * built from the volume/chapter rows alone, so a model asked to "route a
   * task" was never told what the task was (Wave 2 review, C-3).
   *
   * Optional, not required, so existing hand-built payloads outside this
   * package (test fixtures in sibling packages) keep compiling unchanged —
   * `buildRoutePayload` always populates it with a real string (or `""`
   * when nothing is available, e.g. the CLI's own `find` command, which
   * already threads `query` through its own result types independently and
   * can leave this blank without losing anything). Treat a missing value
   * the same as `""` (see `ModelNavigationAgent.route`).
   */
  readonly query?: string;
  /** `true` when the corpus is at or under `CHAPTER_INDEX_THRESHOLD`: the agent should skip straight to STAGE 3 over the full chapter index. `volumes` is empty in that case — there is nothing to route. */
  readonly skip: boolean;
  readonly volumes: readonly VolumeManifestRow[];
}

function toVolumeManifestRow(volume: VolumeIndexNode): VolumeManifestRow {
  return {
    volume_id: volume.volume_id,
    title: volume.title,
    type: volume.type,
    when_to_use: volume.when_to_use,
    not_for: volume.not_for,
    keywords: volume.keywords,
    chapter_count: volume.chapter_count,
  };
}

/**
 * Build the STAGE 2 (ROUTE) payload: the volume manifest, or a `skip`
 * signal when the corpus is small enough to skip straight to the chapter
 * index.
 *
 * `query` is optional and defaults to `""` purely so existing callers that
 * have nowhere to source one keep compiling unchanged — every in-process
 * caller that actually drives a `NavigationAgent` (`ReasoningNavigator` in
 * `navigator.ts`) always has the real task in scope and always passes it.
 */
export function buildRoutePayload(document: IndexDocument, query = ""): RoutePayload {
  if (shouldSkipRouting(document)) {
    return { stage: "route", query, skip: true, volumes: [] };
  }
  return {
    stage: "route",
    query,
    skip: false,
    volumes: document.volumes.map(toVolumeManifestRow),
  };
}

/** One chapter row of the STAGE 3 (NAVIGATE) payload, exactly the field set `docs/INDEXING.md` specifies. */
export interface ChapterIndexRow {
  readonly node_id: string;
  readonly title: string;
  readonly when_to_use?: string;
  readonly not_for?: string;
  readonly keywords?: readonly string[];
  readonly tokens: number;
  readonly updated?: string;
  readonly confidence?: Confidence;
  /** OKF v0.2 lifecycle status — `draft`, `stable`, or `deprecated` (OKF §5.4). */
  readonly status?: string;
  /** The `node_id` of the chapter that supersedes this one, if any — derived from *other* chapters' `supersedes` lists, not authored on this chapter directly. */
  readonly superseded_by?: string;
}

export interface NavigatePayload {
  readonly stage: "navigate";
  /** The task being navigated. See `RoutePayload.query`'s doc comment — same rationale, same C-3 fix, same optionality. */
  readonly query?: string;
  readonly round: number;
  readonly chapters: readonly ChapterIndexRow[];
  /** Carried forward so the agent does not reselect (`docs/INDEXING.md`: "Carry visited[] forward"). Chapters whose `node_id` is in this list are already excluded from `chapters` below. */
  readonly visited: readonly string[];
}

/** Map every chapter's `node_id` to the `node_id` of whichever chapter lists it in `supersedes`, across the whole corpus. */
function buildSupersededByMap(document: IndexDocument): ReadonlyMap<string, string> {
  const supersededBy = new Map<string, string>();
  for (const volume of document.volumes) {
    for (const chapter of volume.chapters) {
      for (const supersededId of chapter.supersedes ?? []) {
        supersededBy.set(supersededId, chapter.node_id);
      }
    }
  }
  return supersededBy;
}

export interface BuildNavigatePayloadOptions {
  /** The task being navigated (`NavigatePayload.query`). Defaults to `""` — see `buildRoutePayload`'s doc comment for why this stays optional. */
  readonly query?: string;
  /** Restrict to these `volume_id`s (STAGE 2 routed to a subset). Omit to include every volume — the ≤60-chapter skip-routing case. */
  readonly volumeIds?: readonly string[];
  /** Chapters already shown/decided on in a previous round; excluded from `chapters` and echoed back in the payload. */
  readonly visited?: readonly string[];
  /** 1-based round number. Defaults to `1`. */
  readonly round?: number;
}

/** Build the STAGE 3 (NAVIGATE) payload: chapter rows for the routed volume(s) (or the whole corpus), excluding `visited`. */
export function buildNavigatePayload(
  document: IndexDocument,
  options: BuildNavigatePayloadOptions = {},
): NavigatePayload {
  const query = options.query ?? "";
  const visited = options.visited ?? [];
  const visitedSet = new Set(visited);
  const volumeIdSet = options.volumeIds ? new Set(options.volumeIds) : undefined;
  const supersededBy = buildSupersededByMap(document);

  const chapters = document.volumes
    .filter((volume) => !volumeIdSet || volumeIdSet.has(volume.volume_id))
    .flatMap((volume) => volume.chapters)
    .filter((chapter) => !visitedSet.has(chapter.node_id))
    .map(
      (chapter): ChapterIndexRow => ({
        node_id: chapter.node_id,
        title: chapter.title,
        when_to_use: chapter.when_to_use,
        not_for: chapter.not_for,
        keywords: chapter.keywords,
        tokens: chapter.tokens,
        updated: chapter.updated,
        confidence: chapter.confidence,
        status: chapter.status,
        superseded_by: supersededBy.get(chapter.node_id),
      }),
    );

  return { stage: "navigate", query, round: options.round ?? 1, chapters, visited };
}
