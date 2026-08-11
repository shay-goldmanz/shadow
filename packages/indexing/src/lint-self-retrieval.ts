/**
 * Check 2 — coverage / self-retrieval (D14): "generate a plausible task per
 * chapter and check the router returns that chapter. A chapter that cannot
 * retrieve itself has a bad `when_to_use`." Model-backed — generating a
 * plausible task is judgment (`@shadow/model`'s structured-generation
 * port), and so is every stage of the retrieval it then drives.
 *
 * Deliberately **reuses** T2.3's `ReasoningNavigator`/`Navigator` rather
 * than reimplementing routing: "run the router" means exactly that router
 * — the one production retrieval (`shadow find`, T3.1) will eventually
 * use — driven end-to-end by `ModelNavigationAgent`
 * (`lint-model-navigation-agent.ts`), never a bespoke lint-only shortcut.
 * "Zero labels" (D14) holds here in the strict sense: nothing about a
 * probe's expected answer is hand-authored — the task comes from the
 * chapter's own `when_to_use`, and "does it come back" is checked purely
 * structurally against the trace.
 *
 * This is also where check 5's miss log gets populated (`lint-miss-
 * log.ts`): every probe's `not-in-corpus` verdict is appended, and every
 * probe's citations are unioned into a `coverage` set that `lint.ts`
 * hands to check 3 (orphan detection) afterward.
 */

import type { VolumeStore } from "@shadow/core";
import type { StructuredGenerationPort } from "@shadow/model";
import { z } from "zod";
import type { MissLogStore } from "./lint-miss-log.ts";
import { ModelNavigationAgent } from "./lint-model-navigation-agent.ts";
import type { LintCheckResult, LintFinding } from "./lint-types.ts";
import { ReasoningNavigator } from "./navigator.ts";
import type { Citation, RetrievalVerdict } from "./trace.ts";
import type { ChapterIndexNode, IndexDocument } from "./types.ts";

const taskSchema = z.object({
  task: z.string().describe("a short, realistic task a coding agent would search a volume for"),
});

/** One chapter's probe: the generated task, whether the chapter retrieved itself, and the raw trace outcome for callers that want more than the pass/fail finding. */
export interface SelfRetrievalProbe {
  readonly chapterId: string;
  readonly task: string;
  readonly retrievedSelf: boolean;
  readonly verdict: RetrievalVerdict;
  readonly citedNodeIds: readonly string[];
}

export interface SelfRetrievalOptions {
  /** Every `not-in-corpus` verdict is appended here (check 5, D14). Omit to skip miss logging (e.g. a caller that only wants the pass/fail findings). */
  readonly missLog?: MissLogStore;
  /** Injectable clock for `MissLogEntry.recordedAt` — deterministic tests. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

export interface SelfRetrievalRunResult {
  readonly result: LintCheckResult;
  /** Every probe run, in chapter order — the raw material `@shadow/evaluation` (T4.1) consumes as a metric per the brief ("`@shadow/evaluation` will consume the self-retrieval results as a metric"). */
  readonly probes: readonly SelfRetrievalProbe[];
  /** Union of every probe's cited node_ids across the whole run — feed directly into `lint-orphan.ts`'s `checkOrphans`. */
  readonly coverage: ReadonlySet<string>;
}

async function generatePlausibleTask(
  port: StructuredGenerationPort,
  chapter: ChapterIndexNode,
): Promise<string> {
  const { object } = await port.generate({
    schema: taskSchema,
    schemaName: "plausible_task",
    system:
      "Given one documentation chapter's applicability statement (when it should be used, and what it explicitly does not cover), write one short, realistic task a coding agent would search for that this chapter should answer. Do not quote the chapter's title verbatim.",
    prompt: `Chapter: ${chapter.title}\nwhen_to_use: ${chapter.when_to_use ?? "(none authored)"}\nnot_for: ${chapter.not_for ?? "(none authored)"}`,
  });
  return object.task;
}

/** A chapter counts as retrieved if it was cited directly, or if any of its own sections were (`docs/INDEXING.md`: passages come back at section granularity, not whole chapters). */
function isChapterCited(chapterId: string, citations: readonly Citation[]): boolean {
  return citations.some(
    (citation) => citation.node_id === chapterId || citation.node_id.startsWith(`${chapterId}#`),
  );
}

/** Run one self-retrieval probe per chapter in `document`, in document order. */
export async function checkSelfRetrieval(
  document: IndexDocument,
  store: VolumeStore,
  port: StructuredGenerationPort,
  options: SelfRetrievalOptions = {},
): Promise<SelfRetrievalRunResult> {
  const navigator = new ReasoningNavigator(store, new ModelNavigationAgent(port));
  const now = options.now ?? (() => new Date());
  const probes: SelfRetrievalProbe[] = [];
  const findings: LintFinding[] = [];
  const coverage = new Set<string>();

  for (const volume of document.volumes) {
    for (const chapter of volume.chapters) {
      const task = await generatePlausibleTask(port, chapter);
      const trace = await navigator.find(document, task);
      const citedNodeIds = trace.citations.map((citation) => citation.node_id);
      for (const nodeId of citedNodeIds) {
        coverage.add(nodeId);
      }

      const retrievedSelf = isChapterCited(chapter.node_id, trace.citations);
      probes.push({
        chapterId: chapter.node_id,
        task,
        retrievedSelf,
        verdict: trace.verdict,
        citedNodeIds,
      });

      if (!retrievedSelf) {
        findings.push({
          code: "self-retrieval-miss",
          severity: "error",
          message: `"${chapter.title}" could not retrieve itself for a task generated from its own when_to_use ("${task}") — its when_to_use is likely vague, wrong, or shadowed by a better-matched sibling`,
          nodeIds: [chapter.node_id],
          data: { task, verdict: trace.verdict, citedNodeIds },
        });
      }

      if (trace.verdict.kind === "not-in-corpus" && options.missLog) {
        await options.missLog.append({
          task,
          sourceChapterId: chapter.node_id,
          recordedAt: now().toISOString(),
        });
      }
    }
  }

  return {
    result: { checkId: "self-retrieval", requiresModel: true, findings },
    probes,
    coverage,
  };
}
