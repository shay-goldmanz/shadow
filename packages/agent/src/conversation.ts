/**
 * The conversation loop: one `AgenticSession` per conversation, reused
 * across turns (D6), driving research delegation, chapter drafting, and
 * publication as an in-band directive protocol (`system-prompt.ts`,
 * `directives.ts`) rather than Agent SDK tool calls — see
 * `system-prompt.ts`'s module doc for why.
 *
 * ## The auto-continuation loop
 *
 * One operator message can span several underlying model turns:
 *
 * 1. The operator's turn is recorded as a citable transcript source
 *    (`@shadow/research`'s `recordSessionTranscriptSource` — D19/D23's
 *    *only* legitimate way to write down what the operator believes) and
 *    sent to Shadow.
 * 2. Shadow's reply may contain `shadow:research`/`shadow:chapter`
 *    directives. Each is handled in this package's own code — never inside
 *    the model's turn — and the outcome (research findings; a chapter's
 *    audit verdict) is fed back as the *next* turn's prompt, on the *same*
 *    session handle (D6: no new session per round).
 * 3. This repeats until a turn produces no directives at all (Shadow is
 *    just talking) or `maxAutoTurns` is exhausted.
 *
 * This is what makes "operator states a belief covering two topics ->
 * Shadow researches both -> drafts two chapters -> both pass audit ->
 * volume is indexed" a single `sendMessage` call while still being
 * genuinely multi-turn underneath, with research results available to
 * Shadow's chapter-drafting turn *before* it drafts — bind-before-write,
 * enforced by the shape of the protocol, not by instruction alone.
 *
 * ## No tools, ever
 *
 * `allowedTools: ["Skill"]` is exhaustive: Shadow's session can invoke
 * nothing else, so it structurally cannot browse, fetch, shell out, or
 * touch the filesystem directly — matching `@shadow/research`'s
 * `WebResearchToolAgent` "structurally hard to bypass" pattern one level
 * up, at the "any tool at all" granularity rather than "any tool but our
 * three." `disallowedTools` names the risky built-ins anyway, as
 * belt-and-braces against a future change loosening `allowedTools`.
 *
 * ## Same-volume chapter publication is serialized across conversations
 * (T0.6); the reindex step is serialized corpus-wide (F1 review fix)
 *
 * `runChapterDirective` below drafts a chapter and then publishes it
 * (`chapter-draft.ts` + `publish.ts`), which read-modify-writes shared
 * per-volume files (the claim sidecar, retirement-event appends) and
 * reindexes the corpus. The auto-continuation loop above already runs
 * chapter directives one at a time *within* one conversation, but nothing
 * stopped two different conversations on the *same* volume from racing that
 * shared state — an easy thing to hit once sessions can list and be resumed
 * independently. `ShadowAgent` owns one `VolumeLocks` (`volume-locks.ts`)
 * and hands it to every `ShadowConversation` it mints; `runChapterDirective`
 * holds it for the volume slug across the whole draft-then-publish unit —
 * draft and audit for *different* volumes still run fully in parallel, and
 * research directives are untouched by any of this.
 *
 * Reindexing is not volume-scoped, though: `publishChapter`'s final step
 * reads every volume and rewrites the corpus-wide index plus every volume's
 * own index files, so two publishes on different volumes still race *that*
 * one step even with per-volume locking in place. `runChapterDirective`
 * passes `publishChapter` a `withReindexLock` bound to the *same*
 * `VolumeLocks` instance, keyed on `CORPUS_LOCK_KEY` — a reserved key that
 * cannot collide with a real volume slug (`volume-locks.ts`) — acquired
 * strictly *inside* the volume lock already held, so the corpus-wide
 * critical section is as short as the reindex call itself, never the whole
 * draft-then-publish unit.
 *
 * ## Session persistence is required, not optional (see `getOrCreateSession`)
 *
 * "Reused across turns" above means what it says: this handle sends every
 * turn after the first as `resume: <this handle's own session id>`
 * (`@shadow/model`'s `ClaudeAgentSdkSession`). `resume` only finds a
 * session that was actually written to `~/.claude/projects/`, so this
 * session must NOT be created with `persistSession: false` — see the
 * comment at that call site for the incident this guards against. Cleaning
 * up the resulting on-disk transcript is no longer this handle's job
 * (T2.4/D6b): `release()` below only drops the in-memory reference, and
 * deletion — when the operator actually wants a session gone — is the
 * explicit, id-based `AgenticSessionPort.deleteStoredSession` path instead.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChapterSlug, VolumeSlug, VolumeStore } from "@shadow/core";
import type {
  CheckIssue,
  CheckWorthinessClassifier,
  ClaimRestater,
  EntailmentRelevanceJudge,
  EvidenceStore,
  RepairDecision,
} from "@shadow/evidence";
import type { Indexer } from "@shadow/indexing";
import {
  type AgenticSession,
  type AgenticSessionPort,
  isNoConversationFoundError,
} from "@shadow/model";
import type { ResearchBrief, ResearchBriefPort, ResearchResult } from "@shadow/research";
import { recordSessionTranscriptSource } from "@shadow/research";
import { draftChapter } from "./chapter-draft.ts";
import type { ChapterDirective, ResearchDirective } from "./directives.ts";
import { parseShadowDirectives } from "./directives.ts";
import { AutoTurnBudgetExceededError } from "./errors.ts";
import { type AsyncEventProducer, mergeAsyncEvents } from "./merge-async-events.ts";
import { publishChapter } from "./publish.ts";
import { ensureWritingVolumesSkillInstalled } from "./skills.ts";
import { buildShadowSystemPrompt } from "./system-prompt.ts";
import { CORPUS_LOCK_KEY, VolumeLocks } from "./volume-locks.ts";

export interface ShadowAgentDeps {
  readonly agenticSessionPort: AgenticSessionPort;
  readonly researchBriefPort: ResearchBriefPort;
  readonly volumeStore: VolumeStore;
  readonly evidenceStore: EvidenceStore;
  readonly indexer: Indexer;
  readonly checkWorthinessClassifier: CheckWorthinessClassifier;
  readonly entailmentRelevanceJudge: EntailmentRelevanceJudge;
  readonly claimRestater: ClaimRestater;
  /**
   * Directory whose `.claude/skills/shadow-write-volumes/SKILL.md` Shadow's
   * session discovers (`skills.ts`), and the session's `cwd`. Defaults to
   * the operator's `~/.shadow` root (D4) — the one directory this stack
   * already treats as home. Tests should pass an isolated temp directory.
   */
  readonly sessionCwd?: string;
  readonly model?: string;
  /** Bounds the auto-continuation loop (see module doc). @default 6 */
  readonly maxAutoTurns?: number;
}

export interface StartConversationOptions {
  /** Stable id for this conversation, used to derive the transcript source's `session:<id>` url. Defaults to a fresh random id. */
  readonly conversationId?: string;
  /**
   * Resume a previously-persisted SDK session instead of starting fresh
   * (T2.3). `getOrCreateSession` forwards `sdkSessionId` as
   * `options.resume` on the underlying `AgenticSessionPort.createSession`
   * call — see `@shadow/model`'s `AgenticSessionOptions.resume` — so the
   * conversation's *first* turn continues that transcript rather than
   * opening a new one. `@shadow/api`'s `SessionService` (T2.5) is the
   * intended caller: it rehydrates a cold session id and builds
   * `fallbackSummary` from the stored transcript.
   *
   * Composes with T1.1/T1.2 for free: a transient failure (529/overloaded)
   * on the resumed first turn retries *with resume intact* — the retrying
   * decorator re-issues the same underlying handle, which still carries
   * `options.resume` (`../model/src/retrying-agentic-session.ts`'s module
   * doc). The one failure that decorator never retries — the SDK's
   * "No conversation found" error (`conservativeRetryPolicy`,
   * `isNoConversationFoundError`) — is exactly the one this class's own
   * fallback below handles instead.
   */
  readonly resume?: {
    readonly sdkSessionId: string;
    /**
     * Deterministic prior-conversation context (T2.5 builds this from
     * stored transcript events), used *only* if the resumed first turn
     * fails with "No conversation found" (the SDK transcript is genuinely
     * gone — deleted, expired, moved machines). When present, `sendMessage`
     * drops the dead session handle, opens a fresh one *without* `resume`,
     * and re-issues the same turn with this text prepended to the **model
     * prompt only** — never to the recorded operator transcript source
     * (D19/D23; see `sendMessage`'s doc). Omit this to leave "No
     * conversation found" on the resumed first turn unhandled — it
     * propagates as an ordinary error, same as any other channel this
     * class doesn't special-case.
     */
    readonly fallbackSummary?: string;
  };
}

/**
 * Prepended to the model prompt (never to the recorded operator transcript
 * source) when T2.3's in-conversation resume fallback fires — the exact
 * framing the plan specifies, so `fallbackSummary` reads as recovered
 * context rather than something the operator just said, and Shadow never
 * cites it as an `operator`-kind claim's source.
 */
function buildFallbackPrompt(fallbackSummary: string, prompt: string): string {
  return [
    "Context recovered from a previous conversation — not operator speech; " +
      "never cite it as an operator source.",
    fallbackSummary,
    "",
    prompt,
  ].join("\n");
}

export type ShadowEvent =
  | { readonly type: "operator-turn-recorded"; readonly sourceId: string }
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "assistant-message"; readonly text: string }
  | { readonly type: "research-started"; readonly brief: ResearchBrief }
  | {
      readonly type: "research-completed";
      readonly brief: ResearchBrief;
      readonly result: ResearchResult;
    }
  | { readonly type: "research-failed"; readonly brief: ResearchBrief; readonly error: string }
  | { readonly type: "chapter-drafted"; readonly volume: VolumeSlug; readonly chapter: ChapterSlug }
  | {
      readonly type: "chapter-audit";
      readonly volume: VolumeSlug;
      readonly chapter: ChapterSlug;
      readonly passed: boolean;
      readonly repairs: readonly RepairDecision[];
    }
  | {
      readonly type: "chapter-published";
      readonly volume: VolumeSlug;
      readonly chapter: ChapterSlug;
    }
  | {
      readonly type: "chapter-rejected";
      readonly volume: VolumeSlug;
      readonly chapter: ChapterSlug;
      readonly issues: readonly CheckIssue[];
    }
  | { readonly type: "error"; readonly error: string };

function toResearchBrief(volume: VolumeSlug, directive: ResearchDirective): ResearchBrief {
  return {
    volume,
    goal: directive.goal,
    subjectDomains: directive.subjectDomains,
    constraints: directive.constraints,
    maxSources: directive.maxSources,
  };
}

function buildOperatorPrompt(operatorText: string, sourceId: string): string {
  return [
    `Operator (sourceId: ${sourceId}):`,
    operatorText,
    "",
    `If you write an operator-kind claim ([^~label]) distilling something the operator just ` +
      `said, cite sourceId "${sourceId}" with an exact quote copied verbatim from the line ` +
      `above — never a paraphrase.`,
  ].join("\n");
}

function formatResearchResult(brief: ResearchBrief, result: ResearchResult): string {
  const lines = [`Research findings for "${brief.goal}":`];
  for (const finding of result.findings) {
    lines.push(`- ${finding.text}`);
    for (const citation of finding.citations) {
      lines.push(`  sourceId: ${citation.sourceId}`);
      lines.push(`  quote: ${JSON.stringify(citation.quote)}`);
    }
  }
  return lines.join("\n");
}

function formatResearchFailure(brief: ResearchBrief, error: string): string {
  return `Research brief "${brief.goal}" failed: ${error}`;
}

function formatChapterOutcome(
  slug: ChapterSlug,
  published: boolean,
  issues: readonly CheckIssue[],
  repairs: readonly RepairDecision[],
): string {
  if (published) {
    return `Chapter "${slug}" passed the evidence audit, was published, and the corpus was reindexed.`;
  }
  const repairNote =
    repairs.length > 0
      ? ` ${repairs.length} claim(s) were restated (${repairs.filter((r) => r.outcome === "escalated").length} escalated to you rather than auto-applied).`
      : "";
  const issueText =
    issues.length > 0 ? issues.map((issue) => issue.message).join("; ") : "see verdict";
  return `Chapter "${slug}" FAILED the evidence audit and was NOT published: ${issueText}.${repairNote} Fix and resubmit a corrected shadow:chapter block if you can.`;
}

function formatChapterDraftFailure(slug: string, error: string): string {
  return `Your shadow:chapter block for "${slug}" could not be drafted: ${error}. Fix and resubmit.`;
}

/** Shadow's per-conversation handle: one `AgenticSession`, reused for every `sendMessage` call (D6). Create via `ShadowAgent.startConversation`. */
export class ShadowConversation {
  private readonly conversationId: string;
  private session: AgenticSession | undefined;
  /**
   * `StartConversationOptions.resume`, while it's still live. Consulted by
   * `getOrCreateSession` (forwarded as `options.resume` on session
   * creation) and by `sendMessage`'s fallback (T2.3, this module's doc on
   * `StartConversationOptions.resume`). Cleared — not just ignored — once
   * the fallback fires: the recreated session must never itself carry
   * `resume`, and `getOrCreateSession` reads this same field to decide.
   */
  private pendingResume: StartConversationOptions["resume"];

  constructor(
    private readonly deps: ShadowAgentDeps,
    private readonly volume: VolumeSlug,
    /** Shared with every other conversation `ShadowAgent` mints — see this module's T0.6 doc above. */
    private readonly volumeLocks: VolumeLocks,
    options: StartConversationOptions = {},
  ) {
    this.conversationId = options.conversationId ?? randomUUID();
    this.pendingResume = options.resume;
  }

  get id(): string {
    return this.conversationId;
  }

  /** The underlying `AgenticSession`'s own session id — `undefined` until the first turn completes, then stable (D6). Exposed for callers/tests that want to confirm reuse without reaching into internals. */
  get sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  /**
   * Drop this handle's reference to its underlying `AgenticSession`,
   * deleting nothing (T2.4 — replaces the old `dispose()`, which called
   * `AgenticSession.close()` and deleted the SDK transcript underneath it).
   *
   * D6b inverts D6a's cleanup rule: sessions now persist *past* the life of
   * this in-memory handle (`@shadow/sessions`, Tier 2) — the SDK transcript
   * is the entity of record, and this handle is only ever a cache entry for
   * it. Releasing a cache entry must not delete the entity it cached, so
   * eviction (`ConversationRegistry`) and server shutdown (`start.ts`) both
   * call this instead of anything that touches `~/.claude/projects/`. The
   * one legitimate deletion path left is explicit and id-based —
   * `AgenticSessionPort.deleteStoredSession(sdkSessionId)`, driven by
   * `SessionMeta.sdkSessionId` (T3.1's `DELETE` endpoint) — and it never
   * goes through a `ShadowConversation` handle at all, which is what makes
   * it work for a *cold* session (evicted or post-restart) that has no live
   * handle for this method to even be called on.
   *
   * Nothing else needs releasing here: every `stream()` call spawns its own
   * subprocess, which exits when that turn's `result` message arrives
   * (module doc above) — this handle holds no live process, socket, or
   * other non-transcript resource between turns, so dropping the reference
   * is genuinely all there is to do today. Doing that explicitly (rather
   * than leaving it to whatever the caller does with its own reference to
   * this object) also means a caller that mistakenly reuses an "inert"
   * handle after release gets a fresh, non-resuming session on its next
   * `sendMessage` rather than silently reaching for a resume target this
   * class no longer stands behind. If a future change gives `AgenticSession`
   * genuine non-transcript teardown (an idle subprocess kept warm, say),
   * it belongs here — T2.9's graceful-shutdown sequence is the next caller
   * of this method and needs it to leave nothing dangling.
   */
  async release(): Promise<void> {
    this.session = undefined;
  }

  /**
   * Send one operator message and drive Shadow's response, including any
   * auto-continuation rounds (research delegation, chapter drafting and
   * publication) it triggers. Streams progress as `ShadowEvent`s so a
   * caller (`@shadow/api`, T3.4) can surface it live.
   *
   * `recordSessionTranscriptSource` below runs exactly once, before any
   * model turn — the *only* legitimate way to write down what the operator
   * said (D19/D23, module doc). T2.3's resume fallback further down this
   * method never re-runs it and never routes `fallbackSummary` through it:
   * the summary only ever gets prepended to a re-issued *model prompt*, so
   * it can never become a citable `operator`-kind source, and the operator
   * turn is never double-recorded.
   */
  async *sendMessage(operatorText: string): AsyncGenerator<ShadowEvent, void, undefined> {
    const operatorSource = await recordSessionTranscriptSource(
      this.deps.evidenceStore,
      this.volume,
      {
        sessionId: this.conversationId,
        turnText: operatorText,
      },
    );
    yield { type: "operator-turn-recorded", sourceId: operatorSource.id };

    const maxAutoTurns = this.deps.maxAutoTurns ?? 6;
    let prompt = buildOperatorPrompt(operatorText, operatorSource.id);

    for (let turn = 0; turn < maxAutoTurns; turn++) {
      // True only for the very first `stream()` call this conversation will
      // ever make on a session created with `resume` — `this.session` is
      // still unset (no turn has ever run on this handle) and there's a
      // `pendingResume` to lose. Every later iteration of this loop reuses
      // the already-created `this.session` (D6), so this is `false` for
      // every turn after the conversation's first — matching the plan's
      // "only the first turn of a resumed conversation falls back."
      const isResumingFirstTurn = this.session === undefined && this.pendingResume !== undefined;
      const session = await this.getOrCreateSession();

      let finalText: string;
      let turnFailed: boolean;
      try {
        ({ finalText, turnFailed } = yield* this.runModelTurn(session, prompt));
      } catch (error) {
        const fallbackSummary = this.pendingResume?.fallbackSummary;
        if (
          !isResumingFirstTurn ||
          fallbackSummary === undefined ||
          !isNoConversationFoundError(error)
        ) {
          // Not T2.3's fallback case: a non-first-turn failure (shouldn't
          // happen — this handle resumes its own id after the first turn),
          // a first turn that wasn't resumed at all, a resumed first turn
          // with no `fallbackSummary` to fall back with (documented
          // behavior — no fallback possible), or a resumed first turn that
          // failed for any other reason (a transient failure already
          // retried *with* resume intact by the decorator before reaching
          // here — see `StartConversationOptions.resume`'s doc). Propagate
          // as an ordinary error; `resume` stays intact on `this.session`
          // (still `undefined` here, so the next call to `getOrCreateSession`
          // — if the caller retries this same conversation — tries the same
          // resume again, unchanged).
          throw error;
        }

        // T2.3 in-conversation fallback: the resumed transcript genuinely
        // doesn't exist on this machine (deleted, expired, moved). Drop the
        // dead handle (`close()` here is a documented no-op for this exact
        // shape — a thrown, pre-"done" failure latches neither `ownSessionId`
        // nor `failedSessionIds` on the underlying session, real adapter or
        // fake alike — kept anyway for defense-in-depth against a future SDK
        // that partially persists before throwing), recreate without
        // `resume`, and re-issue the *same* turn with the summary prepended
        // to the model prompt only (this class doc, `buildFallbackPrompt`).
        await this.session?.close?.();
        this.session = undefined;
        this.pendingResume = undefined;

        const fallbackSession = await this.getOrCreateSession();
        const fallbackPrompt = buildFallbackPrompt(fallbackSummary, prompt);
        ({ finalText, turnFailed } = yield* this.runModelTurn(fallbackSession, fallbackPrompt));
      }
      if (turnFailed) return;

      yield { type: "assistant-message", text: finalText };

      const directives = parseShadowDirectives(finalText);
      if (directives.research.length === 0 && directives.chapters.length === 0) {
        return;
      }

      const followUps: string[] = [];
      for await (const event of this.runResearchDirectives(directives.research, followUps)) {
        yield event;
      }
      for (const directive of directives.chapters) {
        for await (const event of this.runChapterDirective(directive, followUps)) {
          yield event;
        }
      }

      prompt = followUps.join("\n\n");
    }

    throw new AutoTurnBudgetExceededError(maxAutoTurns);
  }

  /**
   * Drive one `session.stream(prompt)` call to completion, yielding
   * `text-delta`/`error` `ShadowEvent`s as they arrive and returning the
   * turn's outcome — factored out of `sendMessage` so T2.3's fallback can
   * re-issue the same logic against a freshly-created session/prompt
   * without duplicating the event-mapping. A thrown failure (including the
   * SDK's no-conversation-found error) propagates out of this generator
   * uncaught; `sendMessage` is the layer that decides whether to catch it.
   */
  private async *runModelTurn(
    session: AgenticSession,
    prompt: string,
  ): AsyncGenerator<ShadowEvent, { finalText: string; turnFailed: boolean }, undefined> {
    let finalText = "";
    let turnFailed = false;

    for await (const event of session.stream(prompt)) {
      if (event.type === "text-delta") {
        yield { type: "text-delta", text: event.text };
      } else if (event.type === "done") {
        finalText = event.result.text;
        if (event.result.isError) {
          turnFailed = true;
          yield {
            type: "error",
            error: `Shadow's turn failed (stopReason: ${event.result.stopReason ?? "unknown"})`,
          };
        }
      }
    }

    return { finalText, turnFailed };
  }

  /**
   * Run every research directive from one model turn concurrently (T0.2).
   * `research-started` fires for all of them up front, in directive order,
   * before any brief's `research()` call begins. Completion events
   * (`research-completed`/`research-failed`) then stream out via
   * `mergeAsyncEvents` in *settle* order — whichever brief finishes first is
   * yielded first — but `followUps` (the next turn's prompt material) is
   * assembled in *directive* order once every brief has settled, so the
   * model always sees a deterministic prompt regardless of network timing.
   * A brief that throws is caught right here and turned into a
   * `research-failed` event/follow-up line, same shape the old sequential
   * code produced — it never sinks the siblings still in flight, because
   * each brief is an independent `Promise` from the start.
   */
  private async *runResearchDirectives(
    directives: readonly ResearchDirective[],
    followUps: string[],
  ): AsyncGenerator<ShadowEvent, void, undefined> {
    if (directives.length === 0) return;

    const briefs = directives.map((directive) => toResearchBrief(this.volume, directive));
    for (const brief of briefs) {
      yield { type: "research-started", brief };
    }

    // Sparse until every producer settles (`mergeAsyncEvents` runs them all
    // concurrently below) — honestly typed as possibly-`undefined` rather
    // than lying with `string[]`; asserted filled at the spread site once
    // every slot is guaranteed set.
    const followUpBySlot: (string | undefined)[] = Array.from({ length: briefs.length });
    const producers: AsyncEventProducer<ShadowEvent>[] = briefs.map(
      (brief, slot) => async (push) => {
        try {
          const result = await this.deps.researchBriefPort.research(brief);
          followUpBySlot[slot] = formatResearchResult(brief, result);
          push({ type: "research-completed", brief, result });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          followUpBySlot[slot] = formatResearchFailure(brief, message);
          push({ type: "research-failed", brief, error: message });
        }
      },
    );

    for await (const event of mergeAsyncEvents(producers)) {
      yield event;
    }

    // Every producer above settled (successfully or not) before
    // `mergeAsyncEvents` returned, and each one unconditionally sets its own
    // slot before pushing its completion event — so every slot is filled by
    // this point; the assertion below documents that invariant instead of
    // silently coercing `undefined` to `string`.
    followUps.push(
      ...followUpBySlot.map((followUp, slot) => {
        if (followUp === undefined) {
          throw new Error(`internal error: research directive slot ${slot} never settled`);
        }
        return followUp;
      }),
    );
  }

  /**
   * Draft, then publish, one chapter directive — the whole read-modify-write
   * unit held under `volumeLocks` for `this.volume` (T0.6, module doc
   * above), so two conversations publishing to the same volume never
   * interleave their sidecar writes/retirement appends/reindex; the reindex
   * step inside `publishChapter` additionally serializes corpus-wide via
   * `CORPUS_LOCK_KEY` (F1 review fix, module doc above).
   *
   * Events stream to the caller as each step completes, via a single-producer
   * `mergeAsyncEvents` that `push`es synchronously from *inside* the locked
   * section (F3/F4 review fix) — a deliberate departure from "collect during
   * the lock, yield only after release": lock hold time no longer depends on
   * how fast the consumer pulls (`push` returns immediately regardless), the
   * caller can observe events like `chapter-drafted` *while the lock is
   * still held* (streaming is no longer delayed for the whole draft+publish
   * unit), and — the correctness fix, not just a latency one — a
   * `publishChapter` throw after a successful draft no longer discards the
   * already-pushed `chapter-drafted` event: `mergeAsyncEvents` drains every
   * buffered event before surfacing a producer's rejection
   * (`merge-async-events.ts`'s documented completion order), so the operator
   * still gets the "a draft landed on disk" signal even when publication
   * itself blows up afterward.
   */
  private async *runChapterDirective(
    directive: ChapterDirective,
    followUps: string[],
  ): AsyncGenerator<ShadowEvent, void, undefined> {
    let followUp: string | undefined;

    yield* mergeAsyncEvents<ShadowEvent>([
      async (push) => {
        await this.volumeLocks.withLock(this.volume, async () => {
          let slug: ChapterSlug;
          try {
            const draft = await draftChapter(this.deps, this.volume, directive);
            slug = draft.chapter.slug;
            push({ type: "chapter-drafted", volume: this.volume, chapter: slug });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            push({
              type: "error",
              error: `Could not draft chapter "${directive.slug}": ${message}`,
            });
            followUp = formatChapterDraftFailure(directive.slug, message);
            return;
          }

          const result = await publishChapter(
            {
              ...this.deps,
              withReindexLock: (fn) => this.volumeLocks.withLock(CORPUS_LOCK_KEY, fn),
            },
            this.volume,
            slug,
          );
          const issues = result.outcomes.flatMap((outcome) => outcome.issues);
          push({
            type: "chapter-audit",
            volume: this.volume,
            chapter: slug,
            passed: result.verdict.passed,
            repairs: result.repairs,
          });
          if (result.published) {
            push({ type: "chapter-published", volume: this.volume, chapter: slug });
          } else {
            push({ type: "chapter-rejected", volume: this.volume, chapter: slug, issues });
          }
          followUp = formatChapterOutcome(slug, result.published, issues, result.repairs);
        });
      },
    ]);

    if (followUp !== undefined) followUps.push(followUp);
  }

  private async getOrCreateSession(): Promise<AgenticSession> {
    if (this.session) return this.session;

    const cwd = this.deps.sessionCwd ?? join(homedir(), ".shadow");
    await ensureWritingVolumesSkillInstalled(cwd);

    this.session = this.deps.agenticSessionPort.createSession({
      model: this.deps.model,
      cwd,
      systemPrompt: buildShadowSystemPrompt(),
      skills: ["shadow-write-volumes"],
      settingSources: ["project"],
      allowedTools: ["Skill"],
      disallowedTools: ["WebFetch", "WebSearch", "Bash", "Read", "Write", "Edit", "Agent", "Task"],
      permissionMode: "default",
      // T2.3: forward `StartConversationOptions.resume`, while it's still
      // set, as this port's own `resume` option — honored only on this
      // handle's first `stream()` call (`@shadow/model`'s
      // `AgenticSessionOptions.resume` doc: "ignored after the first turn
      // of a session that already has its own sessionId"). `undefined`
      // once `sendMessage`'s fallback has cleared `pendingResume` (or if
      // this conversation was never asked to resume anything), so the
      // recreated post-fallback session is a genuinely fresh one.
      resume: this.pendingResume ? { sessionId: this.pendingResume.sdkSessionId } : undefined,
      // Deliberately NOT `persistSession: false`. This handle is reused
      // across every `sendMessage` call and every auto-continuation round
      // (module doc above, D6) via `resume` — and `resume` only works
      // against a session actually written to `~/.claude/projects/`.
      // `persistSession: false` and multi-turn resume are mutually
      // exclusive by construction (see
      // `@shadow/model`'s `AgenticSessionOptions.persistSession` doc); a
      // Wave 3 review proved live that combination throws
      // "No conversation found with session ID: ..." on the very first
      // continuation turn, meaning Shadow could never actually
      // research-then-draft through chat. Omitting the field takes the
      // Agent SDK's own default, which is already `true` — no need to set
      // it explicitly, but the omission itself is the fix, so it is
      // spelled out here rather than left to be silently reintroduced.
      //
      // Cost this incurs (documented, not hidden): every conversation's
      // transcript persists under `~/.claude/projects/` for as long as the
      // operator keeps talking to it — and, as of T2.4/D6b, for as long as
      // the operator wants it resumable *after* that too, since eviction
      // and shutdown now only `release()` this handle rather than deleting
      // anything. The transcript is gone only when something calls
      // `AgenticSessionPort.deleteStoredSession(sdkSessionId)` explicitly
      // (T3.1's `DELETE` endpoint) — deliberate, id-based, and never routed
      // through this handle.
    });
    return this.session;
  }
}

/**
 * Top-level factory: holds Shadow's injected collaborators and mints a
 * `ShadowConversation` per conversation. Also owns the one `VolumeLocks`
 * instance shared by every conversation it mints (T0.6, `conversation.ts`'s
 * module doc) — this is what makes same-volume chapter publication
 * serialized *across* conversations/sessions, not just within one.
 */
export class ShadowAgent {
  private readonly volumeLocks = new VolumeLocks();

  constructor(private readonly deps: ShadowAgentDeps) {}

  startConversation(volume: VolumeSlug, options?: StartConversationOptions): ShadowConversation {
    return new ShadowConversation(this.deps, volume, this.volumeLocks, options);
  }

  /**
   * Run `fn` with `volume`'s lock held — the *same* `VolumeLocks` instance
   * (and therefore the same mutex) every `ShadowConversation` this agent
   * mints uses for chapter publication (T0.6). Exposed so `@shadow/api`'s
   * HTTP chapter-publish handler (`handlers/chapters.ts`, F2 review fix) can
   * serialize against chat-driven publishes on the same volume, not just
   * against other HTTP publishes — without this, the HTTP path bypassed
   * locking entirely.
   */
  withVolumeLock<T>(volume: VolumeSlug, fn: () => Promise<T>): Promise<T> {
    return this.volumeLocks.withLock(volume, fn);
  }

  /**
   * Run `fn` with the corpus-wide reindex lock held (`CORPUS_LOCK_KEY`, F1
   * review fix) — the same lock `ShadowConversation.runChapterDirective`
   * wraps around `publishChapter`'s reindex step. Exposed so the HTTP
   * chapter-publish handler's own `publishChapter` call serializes its
   * reindex against chat-driven publishes on *other* volumes too, not only
   * same-volume ones.
   */
  withReindexLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.volumeLocks.withLock(CORPUS_LOCK_KEY, fn);
  }
}
