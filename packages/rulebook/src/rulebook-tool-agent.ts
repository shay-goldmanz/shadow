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
 * This module instead drives the shared bounded worker pool
 * (`stream-concurrency.ts`'s `streamWithConcurrency`, also used by
 * `finalize-groups.ts`'s batched finalization calls) that pushes each
 * finished chunk's result onto a queue the generator drains as it goes — the
 * "collect via an async queue" option the task named. Its rejection
 * semantics deliberately match a
 * `Promise.all`-shaped primitive's "settle-all, then throw first": a worker
 * whose item throws records the first error, still decrements the
 * remaining-count and wakes the drain loop, and only after every
 * in-flight/queued item has settled does the generator rethrow that first
 * error — so `create()`'s outer `try`/`catch` always gets a chance to yield
 * `failed` instead of hanging forever on an unsettled `remaining` count.
 *
 * **Groups assemble+publish in parallel, bounded by `auditConcurrency`.**
 * `publishGroup` appends to the rule book's shared, append-only ledger
 * (`audit.completed`, `claim.restated`, `claim.label.retired`) via
 * `EvidenceStore.appendLedgerEvent`, but that append is a single-line
 * `appendFile(path, line, { flag: "a" })` — an atomic O_APPEND write, not the
 * read-modify-append this comment used to describe (that TOCTOU was removed;
 * see `@shadow/evidence`'s `store.ts`). Every other write `publishGroup`
 * makes (the group `.md`, its claims sidecar, its audit record) targets a
 * path scoped to that one group, and the Tier-2 ports it calls
 * (`CheckWorthinessClassifier`/`EntailmentRelevanceJudge`/`ClaimRestater`,
 * `tier2-adapters.ts`) hold no shared mutable state. So groups are safe to
 * assemble+publish concurrently; this module still bounds how many run at
 * once via `streamWithConcurrency` and `brief.auditConcurrency`, both to cap
 * concurrent LLM calls and to keep `group-audited` events flowing steadily
 * rather than as one big burst. One remaining shared read:
 * `EvidenceStore.getRetiredLabels` scans the whole ledger, so this module
 * reads it once per run (before the fan-out starts) rather than once per
 * group — see the fan-out below.
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

import { resolve } from "node:path";
import {
  RulebookNotFoundError,
  type RulebookStore,
  toChapterSlug,
  toVolumeSlug,
} from "@shadow/core";
import type {
  CheckOutcome,
  CheckWorthinessClassifier,
  ClaimRestater,
  EntailmentRelevanceJudge,
  EvidenceStore,
  LedgerEvent,
} from "@shadow/evidence";
import {
  addUsage,
  type StructuredGenerationPort,
  type TokenUsage,
  ZERO_USAGE,
} from "@shadow/model";
import { assembleGroup } from "./assembly.ts";
import { chunkDocument, type DocumentChunk } from "./chunker.ts";
import { extractChunk } from "./extraction.ts";
import { finalizeGroups } from "./finalize-groups.ts";
import { ingestDocument } from "./ingest.ts";
import { consolidateRules } from "./merge.ts";
import type { RuleBookPort, RulebookBrief, RulebookEvent, RulebookResult } from "./port.ts";
import { publishGroup } from "./publish-group.ts";
import type { TaxonomyGroup } from "./schemas.ts";
import { streamWithConcurrency } from "./stream-concurrency.ts";
import { planTaxonomy } from "./taxonomy.ts";
import { type ValidatedRule, validateChunkRules } from "./validate.ts";

const DEFAULT_CONCURRENCY = 8;
const DEFAULT_AUDIT_CONCURRENCY = 4;

export interface RulebookToolAgentDeps {
  readonly rulebookStore: RulebookStore;
  readonly evidenceStore: EvidenceStore;
  readonly structuredGeneration: StructuredGenerationPort;
  readonly checkWorthinessClassifier: CheckWorthinessClassifier;
  readonly entailmentRelevanceJudge: EntailmentRelevanceJudge;
  readonly claimRestater: ClaimRestater;
}

/**
 * Process-wide model-tier fallbacks, set once at composition time (e.g.
 * from `SHADOW_RULEBOOK_EXTRACTION_MODEL`/`SHADOW_RULEBOOK_FINALIZE_MODEL`
 * — see `@shadow/api`'s `composition.ts`). A `RulebookBrief`'s own
 * `extractionModel`/`finalizeModel` always wins when set; these are only
 * the fallback when a brief omits them. Both undefined (the default)
 * reproduces today's behavior exactly — no model override anywhere.
 */
export interface RulebookToolAgentOptions {
  readonly extractionModel?: string;
  readonly finalizeModel?: string;
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

interface GroupOutcome {
  readonly groupSlug: string;
  readonly passed: boolean;
  readonly repairs: number;
  readonly issues: readonly string[];
  readonly assemblyDroppedQuotes: number;
  readonly assemblyDroppedRules: number;
}

/**
 * `claim.label.retired` events, keyed by chapter — read once from the
 * ledger per run so each group's `publishGroup` call doesn't re-scan the
 * whole ledger itself (see module doc). Mirrors
 * `EvidenceStore.getRetiredLabels`'s own filter, just batched over every
 * chapter in one pass instead of one `readLedger` per group.
 */
function retiredLabelsByChapter(ledger: readonly LedgerEvent[]): Map<string, Set<string>> {
  const byChapter = new Map<string, Set<string>>();
  for (const event of ledger) {
    if (event.event !== "claim.label.retired") continue;
    const labels = byChapter.get(event.chapter) ?? new Set<string>();
    labels.add(event.label);
    byChapter.set(event.chapter, labels);
  }
  return byChapter;
}

/**
 * The one real `RuleBookPort` implementation: `create(brief)` runs the
 * whole ingest→publish pipeline as an async generator, yielding progress
 * events in order and always terminating in `completed` or `failed` — never
 * a rejected iterator (see the top-level `try`/`catch` in `create`).
 */
export class RulebookToolAgent implements RuleBookPort {
  private busy = false;

  constructor(
    private readonly deps: RulebookToolAgentDeps,
    private readonly options: RulebookToolAgentOptions = {},
  ) {}

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
      ingested = await ingestDocument(
        this.deps.evidenceStore,
        rulebookSlug,
        brief.docPath,
        brief.title,
      );
    } catch (error) {
      yield { type: "failed", error: errorMessage(error) };
      return;
    }

    let usage = ZERO_USAGE;

    const chunks = chunkDocument(ingested.rawText);

    const taxonomy = await planTaxonomy(
      {
        structuredGeneration: this.deps.structuredGeneration,
        rulebookStore: this.deps.rulebookStore,
      },
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

    const menu = taxonomy.groups.map((group) => ({
      slug: group.slug,
      when_to_use: group.when_to_use,
    }));

    // Brief-level override wins; falls back to the process-wide option set
    // at construction time (see `RulebookToolAgentOptions`'s doc). Both
    // undefined leaves `model` undefined end to end — today's behavior.
    const extractionModel = brief.extractionModel ?? this.options.extractionModel;
    const finalizeModel = brief.finalizeModel ?? this.options.finalizeModel;

    const validatedRules: ValidatedRule[] = [];
    let droppedQuotesFromValidation = 0;
    let failedChunks = 0;
    let completed = 0;

    const extractOneChunk = async (chunk: DocumentChunk): Promise<ChunkOutcome> => {
      const extraction = await extractChunk(
        {
          structuredGeneration: this.deps.structuredGeneration,
          rulebookStore: this.deps.rulebookStore,
        },
        { rulebookSlug, chunk, groups: menu, model: extractionModel },
      );
      if (extraction.failed) {
        return { rules: [], cached: false, failed: true, usage: extraction.usage };
      }
      const validation = validateChunkRules(extraction.rules, ingested.normalizedText);
      droppedQuotesFromValidation += validation.droppedQuotes;
      return {
        rules: validation.kept,
        cached: extraction.cached,
        failed: false,
        usage: extraction.usage,
      };
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
      {
        structuredGeneration: this.deps.structuredGeneration,
        rulebookStore: this.deps.rulebookStore,
      },
      {
        rulebookSlug,
        rules: consolidated,
        groups: taxonomy.groups,
        concurrency: brief.concurrency ?? DEFAULT_CONCURRENCY,
        model: finalizeModel,
      },
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

    // One whole-ledger read for the entire run (see module doc) instead of
    // one per group inside `publishGroup`.
    const retiredByChapter = retiredLabelsByChapter(
      await this.deps.evidenceStore.readLedger(rulebookSlug),
    );

    const auditOneGroup = async (group: TaxonomyGroup): Promise<GroupOutcome> => {
      const rulesForGroup = consolidated.filter(
        (rule) => finalized.assignments.get(rule.label) === group.slug,
      );
      const groupSlug = toChapterSlug(group.slug);

      const assembled = await assembleGroup(
        { rulebookStore: this.deps.rulebookStore, evidenceStore: this.deps.evidenceStore },
        { rulebookSlug, sourceId: ingested.sourceId, group, rules: rulesForGroup },
      );

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
        retiredByChapter.get(groupSlug) ?? new Set<string>(),
      );

      return {
        groupSlug: group.slug,
        passed: published.passed,
        repairs: published.repairs.length,
        issues: issuesFrom(published.outcomes),
        assemblyDroppedQuotes: assembled.droppedQuotes,
        assemblyDroppedRules: assembled.droppedRules,
      };
    };

    // Parallel, bounded by `auditConcurrency` — see module doc. Yields in
    // completion order, not group order; nothing downstream needs group
    // order (same rationale as chunk extraction above).
    for await (const outcome of streamWithConcurrency(
      finalized.groups,
      brief.auditConcurrency ?? DEFAULT_AUDIT_CONCURRENCY,
      auditOneGroup,
    )) {
      assemblyDroppedQuotes += outcome.assemblyDroppedQuotes;
      assemblyDroppedRules += outcome.assemblyDroppedRules;

      if (outcome.passed) {
        publishedGroups.push(outcome.groupSlug);
      } else {
        rejectedGroups.push(outcome.groupSlug);
      }

      yield {
        type: "group-audited",
        group: outcome.groupSlug,
        passed: outcome.passed,
        repairs: outcome.repairs,
        issues: outcome.issues,
      };
    }

    // Stable requires every group to have passed its audit *and* zero failed
    // chunks — a book with silently-missing rules (a chunk whose extraction
    // never even ran) must not read as fully verified just because every
    // group that *did* get assembled happened to pass.
    const isStable =
      finalized.groups.length > 0 && rejectedGroups.length === 0 && failedChunks === 0;

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
