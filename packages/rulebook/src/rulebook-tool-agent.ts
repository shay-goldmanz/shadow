/**
 * `RulebookToolAgent` — the one real `RuleBookPort` implementation, wiring
 * every prior task's piece into the pipeline `port.ts`'s module doc
 * describes: ingest → chunk → taxonomy → parallel extraction (validated as
 * it streams in) → consolidate/finalize groups → assemble → publish, one
 * group at a time.
 *
 * **Chunk extraction streams progress as work completes, not after it all
 * finishes.** A `Promise.all`-shaped batch primitive is perfect for the
 * pipeline's other fan-outs, but it can only resolve once, at the end, so it
 * cannot itself drive a `chunk-extracted` event per chunk as chunks finish.
 * This module instead runs its own small bounded worker pool
 * (`streamWithConcurrency`) that pushes each finished chunk's result onto a
 * queue the generator drains as it goes — the "collect via an async queue"
 * option the task named. Its rejection semantics deliberately match a
 * `Promise.all`-shaped primitive's "settle-all, then throw first": a worker
 * whose item throws records the first error, still decrements the
 * remaining-count and wakes the drain loop, and only after every
 * in-flight/queued item has settled does the generator rethrow that first
 * error — so `create()`'s outer `try`/`catch` always gets a chance to yield
 * `failed` instead of hanging forever on an unsettled `remaining` count.
 *
 * **Groups publish sequentially, deliberately.** `publishGroup` appends
 * to the rule book's shared, append-only ledger (`audit.completed`,
 * `claim.restated`, `claim.label.retired`) via
 * `EvidenceStore.appendLedgerEvent`, which is a read-modify-append over one
 * file with no mutex. Running every group's publish concurrently would race
 * that append across groups. A future optimization (noted here, not
 * implemented) would either put a mutex around the ledger file or batch
 * appends per run; at current scale, one document rarely has enough groups
 * for the serialization to matter, so simple-and-correct wins.
 *
 * **Audit usage is not accumulated.** `RulebookResult.usage` sums
 * `planTaxonomy`/`extractChunk`/`finalizeGroups`'s `TokenUsage` — every
 * structured call this module drives directly. `runFullAudit`'s Tier 2
 * ports (`CheckWorthinessClassifier`/`EntailmentRelevanceJudge`/
 * `ClaimRestater`) do not return `TokenUsage` at all (see `ports.ts`), so
 * whatever tokens a real audit call spends are invisible to this port's
 * usage total — a gap in `@shadow/evidence`'s Tier 2 ports, not something
 * fixable from this module.
 */

import {
  type RulebookStore,
  RulebookNotFoundError,
  toChapterSlug,
  toVolumeSlug,
} from "@shadow/core";
import type {
  CheckOutcome,
  CheckWorthinessClassifier,
  ClaimRestater,
  EntailmentRelevanceJudge,
  EvidenceStore,
} from "@shadow/evidence";
import { addUsage, type StructuredGenerationPort, type TokenUsage, ZERO_USAGE } from "@shadow/model";
import { resolve } from "node:path";
import { assembleGroup } from "./assembly.ts";
import { chunkDocument, type DocumentChunk } from "./chunker.ts";
import { extractChunk } from "./extraction.ts";
import { finalizeGroups } from "./finalize-groups.ts";
import { ingestDocument } from "./ingest.ts";
import { consolidateRules } from "./merge.ts";
import type { RulebookBrief, RulebookEvent, RulebookResult, RuleBookPort } from "./port.ts";
import { publishGroup } from "./publish-group.ts";
import { planTaxonomy } from "./taxonomy.ts";
import { validateChunkRules, type ValidatedRule } from "./validate.ts";

const DEFAULT_CONCURRENCY = 6;

export interface RulebookToolAgentDeps {
  readonly rulebookStore: RulebookStore;
  readonly evidenceStore: EvidenceStore;
  readonly structuredGeneration: StructuredGenerationPort;
  readonly checkWorthinessClassifier: CheckWorthinessClassifier;
  readonly entailmentRelevanceJudge: EntailmentRelevanceJudge;
  readonly claimRestater: ClaimRestater;
}

function issuesFrom(outcomes: readonly CheckOutcome[]): string[] {
  return outcomes
    .filter((outcome) => outcome.blocking && !outcome.passed)
    .flatMap((outcome) => outcome.issues.map((issue) => issue.message));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ChunkOutcome {
  readonly rules: readonly ValidatedRule[];
  readonly cached: boolean;
  readonly failed: boolean;
  readonly usage: TokenUsage;
}

/**
 * Run `worker` over `items` with up to `concurrency` in flight, yielding
 * each result as soon as it's ready rather than only once every item is
 * done — the streaming counterpart to a `Promise.all`-shaped batch
 * primitive this module's progress events need. Completion order, not
 * input order (nothing downstream needs input order — see module doc).
 *
 * Settle-all-then-throw-first: a worker whose item throws (e.g. a
 * corrupted extraction-cache JSON) is caught here, not left to reject the
 * worker's promise silently — `remaining` still decrements and the drain
 * loop still wakes, so the loop always terminates; once every item has
 * settled, the first recorded error (if any) is rethrown out of the
 * generator itself, reaching `create()`'s outer `try`/`catch`.
 */
async function* streamWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): AsyncGenerator<R> {
  if (items.length === 0) return;

  const ready: R[] = [];
  let wake: (() => void) | undefined;
  let nextIndex = 0;
  let remaining = items.length;
  let failed = false;
  let firstError: unknown;

  function notify(): void {
    if (wake) {
      const resolveWake = wake;
      wake = undefined;
      resolveWake();
    }
  }

  async function runWorker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        const result = await worker(items[index] as T);
        ready.push(result);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      } finally {
        remaining -= 1;
        notify();
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, () => runWorker());

  while (remaining > 0 || ready.length > 0) {
    if (ready.length > 0) {
      yield ready.shift() as R;
      continue;
    }
    await new Promise<void>((resolvePromise) => {
      wake = resolvePromise;
    });
  }

  await Promise.all(workers);
  if (failed) throw firstError;
}

/**
 * The one real `RuleBookPort` implementation: `create(brief)` runs the
 * whole ingest→publish pipeline as an async generator, yielding progress
 * events in order and always terminating in `completed` or `failed` — never
 * a rejected iterator (see the top-level `try`/`catch` in `create`).
 */
export class RulebookToolAgent implements RuleBookPort {
  private busy = false;

  constructor(private readonly deps: RulebookToolAgentDeps) {}

  async *create(brief: RulebookBrief): AsyncIterable<RulebookEvent> {
    if (this.busy) {
      yield {
        type: "failed",
        error: "RulebookToolAgent is already running a rule book — one run at a time per instance.",
      };
      return;
    }
    this.busy = true;
    try {
      yield* this.run(brief);
    } catch (error) {
      yield { type: "failed", error: errorMessage(error) };
    } finally {
      this.busy = false;
    }
  }

  private async *run(brief: RulebookBrief): AsyncGenerator<RulebookEvent> {
    yield { type: "started", slug: brief.slug, docPath: brief.docPath };

    const rulebookSlug = toVolumeSlug(brief.slug);

    try {
      await this.deps.rulebookStore.getRulebook(rulebookSlug);
    } catch (error) {
      if (!(error instanceof RulebookNotFoundError)) throw error;
      await this.deps.rulebookStore.createRulebook({
        slug: rulebookSlug,
        title: brief.title,
      });
    }

    let ingested: Awaited<ReturnType<typeof ingestDocument>>;
    try {
      ingested = await ingestDocument(this.deps.evidenceStore, rulebookSlug, brief.docPath, brief.title);
    } catch (error) {
      yield { type: "failed", error: errorMessage(error) };
      return;
    }

    let usage = ZERO_USAGE;

    const chunks = chunkDocument(ingested.rawText);

    const taxonomy = await planTaxonomy(
      { structuredGeneration: this.deps.structuredGeneration, rulebookStore: this.deps.rulebookStore },
      {
        rulebookSlug,
        chunks,
        snapshotSha256: ingested.snapshotSha256,
        scope: brief.scope,
        constraints: brief.constraints,
        maxGroups: brief.maxGroups,
      },
    );
    usage = addUsage(usage, taxonomy.usage);

    yield {
      type: "planned",
      chunkCount: chunks.length,
      groups: taxonomy.groups.map((group) => group.slug),
    };

    const menu = taxonomy.groups.map((group) => ({ slug: group.slug, when_to_use: group.when_to_use }));

    const validatedRules: ValidatedRule[] = [];
    let droppedQuotesFromValidation = 0;
    let failedChunks = 0;
    let completed = 0;

    const extractOneChunk = async (chunk: DocumentChunk): Promise<ChunkOutcome> => {
      const extraction = await extractChunk(
        { structuredGeneration: this.deps.structuredGeneration, rulebookStore: this.deps.rulebookStore },
        { rulebookSlug, chunk, groups: menu },
      );
      if (extraction.failed) {
        return { rules: [], cached: false, failed: true, usage: extraction.usage };
      }
      const validation = validateChunkRules(extraction.rules, ingested.normalizedText);
      droppedQuotesFromValidation += validation.droppedQuotes;
      return { rules: validation.kept, cached: extraction.cached, failed: false, usage: extraction.usage };
    };

    for await (const outcome of streamWithConcurrency(
      chunks,
      brief.concurrency ?? DEFAULT_CONCURRENCY,
      extractOneChunk,
    )) {
      completed += 1;
      usage = addUsage(usage, outcome.usage);
      if (outcome.failed) failedChunks += 1;
      validatedRules.push(...outcome.rules);
      yield {
        type: "chunk-extracted",
        completed,
        total: chunks.length,
        rulesSoFar: validatedRules.length,
        cached: outcome.cached,
        failed: outcome.failed,
      };
    }

    const consolidated = consolidateRules(validatedRules);

    const finalized = await finalizeGroups(
      { structuredGeneration: this.deps.structuredGeneration },
      { rules: consolidated, groups: taxonomy.groups },
    );
    usage = addUsage(usage, finalized.usage);

    yield {
      type: "merged",
      ruleCount: validatedRules.length,
      droppedQuotes: droppedQuotesFromValidation,
      consolidated: consolidated.length,
    };

    const publishedGroups: string[] = [];
    const rejectedGroups: string[] = [];
    let assemblyDroppedQuotes = 0;
    let assemblyDroppedRules = 0;

    // Sequential, deliberately — see module doc's "Groups publish sequentially".
    for (const group of finalized.groups) {
      const rulesForGroup = consolidated.filter((rule) => finalized.assignments.get(rule.label) === group.slug);
      const groupSlug = toChapterSlug(group.slug);

      const assembled = await assembleGroup(
        { rulebookStore: this.deps.rulebookStore, evidenceStore: this.deps.evidenceStore },
        { rulebookSlug, sourceId: ingested.sourceId, group, rules: rulesForGroup },
      );
      assemblyDroppedQuotes += assembled.droppedQuotes;
      assemblyDroppedRules += assembled.droppedRules;

      const published = await publishGroup(
        {
          rulebookStore: this.deps.rulebookStore,
          evidenceStore: this.deps.evidenceStore,
          checkWorthinessClassifier: this.deps.checkWorthinessClassifier,
          entailmentRelevanceJudge: this.deps.entailmentRelevanceJudge,
          claimRestater: this.deps.claimRestater,
        },
        rulebookSlug,
        groupSlug,
      );

      if (published.passed) {
        publishedGroups.push(group.slug);
      } else {
        rejectedGroups.push(group.slug);
      }

      yield {
        type: "group-audited",
        group: group.slug,
        passed: published.passed,
        repairs: published.repairs.length,
        issues: issuesFrom(published.outcomes),
      };
    }

    // Stable requires every group to have passed its audit *and* zero failed
    // chunks — a book with silently-missing rules (a chunk whose extraction
    // never even ran) must not read as fully verified just because every
    // group that *did* get assembled happened to pass.
    const isStable = finalized.groups.length > 0 && rejectedGroups.length === 0 && failedChunks === 0;

    await this.deps.rulebookStore.updateRulebook({
      slug: rulebookSlug,
      title: brief.title,
      sourceDoc: {
        url: `file://${resolve(brief.docPath)}`,
        payloadSha256: ingested.payloadSha256,
        snapshotSha256: ingested.snapshotSha256,
      },
      status: isStable ? "stable" : "draft",
      generated: { by: "process:rulebook", at: new Date() },
      // Built fresh every run, never appended to `rulebook.verified` — a
      // `process:audit` entry from a stale prior run must not survive a run
      // that no longer earns it.
      verified: isStable ? [{ by: "process:audit", at: new Date() }] : [],
      whenToUse: brief.scope,
    });

    const result: RulebookResult = {
      slug: brief.slug,
      sourceId: ingested.sourceId,
      ruleCount: consolidated.length,
      groupCount: finalized.groups.length,
      publishedGroups,
      rejectedGroups,
      failedChunks,
      assemblyDroppedQuotes,
      assemblyDroppedRules,
      usage,
      status: isStable ? "stable" : "draft",
    };

    yield { type: "completed", result };
  }
}
