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
 * ## Same-volume chapter publication is serialized across conversations (T0.6)
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
 * holds it for the volume slug across the whole draft-then-publish unit.
 * Different volumes never contend with each other, and research directives
 * are untouched — only chapter publication needs this.
 *
 * ## Session persistence is required, not optional (see `getOrCreateSession`)
 *
 * "Reused across turns" above means what it says: this handle sends every
 * turn after the first as `resume: <this handle's own session id>`
 * (`@shadow/model`'s `ClaudeAgentSdkSession`). `resume` only finds a
 * session that was actually written to `~/.claude/projects/`, so this
 * session must NOT be created with `persistSession: false` — see the
 * comment at that call site for the incident this guards against, and
 * `ShadowConversation.dispose` for the cleanup this now requires.
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
import type { AgenticSession, AgenticSessionPort } from "@shadow/model";
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
import { VolumeLocks } from "./volume-locks.ts";

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

  constructor(
    private readonly deps: ShadowAgentDeps,
    private readonly volume: VolumeSlug,
    /** Shared with every other conversation `ShadowAgent` mints — see this module's T0.6 doc above. */
    private readonly volumeLocks: VolumeLocks,
    options: StartConversationOptions = {},
  ) {
    this.conversationId = options.conversationId ?? randomUUID();
  }

  get id(): string {
    return this.conversationId;
  }

  /** The underlying `AgenticSession`'s own session id — `undefined` until the first turn completes, then stable (D6). Exposed for callers/tests that want to confirm reuse without reaching into internals. */
  get sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  /**
   * Release the underlying `AgenticSession`'s persisted transcript
   * (`AgenticSession.close`, backed by the Agent SDK's `deleteSession`).
   * This handle deliberately persists its session for `resume` to work
   * across turns — see the comment on `persistSession` in
   * `getOrCreateSession` — which means it accumulates on disk under
   * `~/.claude/projects/` for as long as it stays alive. Nothing in this
   * class calls `dispose` automatically: it has no notion of "the operator
   * is done with this conversation." Whoever owns conversation lifecycle
   * (today, `@shadow/api`'s `ApiDeps.conversations` map) should call this
   * when evicting a conversation. A no-op if no turn has completed yet.
   */
  async dispose(): Promise<void> {
    await this.session?.close?.();
  }

  /**
   * Send one operator message and drive Shadow's response, including any
   * auto-continuation rounds (research delegation, chapter drafting and
   * publication) it triggers. Streams progress as `ShadowEvent`s so a
   * caller (`@shadow/api`, T3.4) can surface it live.
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
      const session = await this.getOrCreateSession();
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

    const followUpBySlot: string[] = Array.from({ length: briefs.length });
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

    followUps.push(...followUpBySlot);
  }

  /**
   * Draft, then publish, one chapter directive — the whole read-modify-write
   * unit held under `volumeLocks` for `this.volume` (T0.6, module doc
   * above), so two conversations publishing to the same volume never
   * interleave their sidecar writes/retirement appends/reindex. The lock is
   * acquired before `draftChapter` and released once `publishChapter` (or a
   * draft failure) is done; events are collected during the locked section
   * and only yielded to the caller after it releases, so this generator's
   * observable output is identical to running the same steps unlocked — the
   * lock changes *when* two conversations' work can overlap, never *what*
   * either one produces.
   */
  private async *runChapterDirective(
    directive: ChapterDirective,
    followUps: string[],
  ): AsyncGenerator<ShadowEvent, void, undefined> {
    const events: ShadowEvent[] = [];
    let followUp: string | undefined;

    await this.volumeLocks.withLock(this.volume, async () => {
      let slug: ChapterSlug;
      try {
        const draft = await draftChapter(this.deps, this.volume, directive);
        slug = draft.chapter.slug;
        events.push({ type: "chapter-drafted", volume: this.volume, chapter: slug });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        events.push({
          type: "error",
          error: `Could not draft chapter "${directive.slug}": ${message}`,
        });
        followUp = formatChapterDraftFailure(directive.slug, message);
        return;
      }

      const result = await publishChapter(this.deps, this.volume, slug);
      const issues = result.outcomes.flatMap((outcome) => outcome.issues);
      events.push({
        type: "chapter-audit",
        volume: this.volume,
        chapter: slug,
        passed: result.verdict.passed,
        repairs: result.repairs,
      });
      if (result.published) {
        events.push({ type: "chapter-published", volume: this.volume, chapter: slug });
      } else {
        events.push({ type: "chapter-rejected", volume: this.volume, chapter: slug, issues });
      }
      followUp = formatChapterOutcome(slug, result.published, issues, result.repairs);
    });

    for (const event of events) yield event;
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
      // transcript now persists under `~/.claude/projects/` for as long as
      // the process keeps this `ShadowConversation` alive. Nothing in this
      // package currently calls the matching cleanup —
      // `AgenticSession.close()` (backed by the SDK's `deleteSession`) is
      // available on `this.session` for whichever layer owns conversation
      // lifecycle (today, `@shadow/api`'s `ApiDeps.conversations` map) to
      // call once a conversation is evicted or the operator ends it.
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
}
