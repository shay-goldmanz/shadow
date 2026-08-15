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
import type { RuleBookPort, RulebookBrief, RulebookResult } from "@shadow/rulebook";
import { draftChapter } from "./chapter-draft.ts";
import type { ChapterDirective, ResearchDirective, RulebookDirective } from "./directives.ts";
import { parseShadowDirectives } from "./directives.ts";
import { AutoTurnBudgetExceededError } from "./errors.ts";
import { publishChapter } from "./publish.ts";
import { ensureWritingVolumesSkillInstalled } from "./skills.ts";
import { buildShadowSystemPrompt } from "./system-prompt.ts";

export interface ShadowAgentDeps {
  readonly agenticSessionPort: AgenticSessionPort;
  readonly researchBriefPort: ResearchBriefPort;
  readonly ruleBookPort: RuleBookPort;
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
  | { readonly type: "rulebook-started"; readonly slug: string; readonly docPath: string }
  | {
      readonly type: "rulebook-planned";
      readonly slug: string;
      readonly chunkCount: number;
      readonly groups: readonly string[];
    }
  | {
      readonly type: "rulebook-chunk";
      readonly slug: string;
      readonly completed: number;
      readonly total: number;
      readonly rulesSoFar: number;
      readonly cached: boolean;
      readonly failed: boolean;
    }
  | {
      readonly type: "rulebook-merged";
      readonly slug: string;
      readonly ruleCount: number;
      readonly droppedQuotes: number;
      readonly consolidated: number;
    }
  | {
      readonly type: "rulebook-group-audited";
      readonly slug: string;
      readonly group: string;
      readonly passed: boolean;
      readonly repairs: number;
      readonly issues: readonly string[];
    }
  | { readonly type: "rulebook-completed"; readonly slug: string; readonly result: RulebookResult }
  | { readonly type: "rulebook-failed"; readonly slug: string; readonly error: string }
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

function toRulebookBrief(directive: RulebookDirective): RulebookBrief {
  return {
    slug: directive.slug,
    title: directive.title,
    docPath: directive.docPath,
    scope: directive.scope,
    constraints: directive.constraints,
    maxGroups: directive.maxGroups,
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

function formatRulebookCompletion(result: RulebookResult): string {
  const lines = [
    `Rule book "${result.slug}" finished: ${result.ruleCount} rule(s) across ` +
      `${result.groupCount} group(s).`,
    `Published groups: ${result.publishedGroups.length > 0 ? result.publishedGroups.join(", ") : "none"}.`,
  ];
  if (result.rejectedGroups.length > 0) {
    lines.push(`Rejected groups (failed their audit): ${result.rejectedGroups.join(", ")}.`);
  }
  if (result.failedChunks > 0) {
    lines.push(
      `${result.failedChunks} chunk(s) of the source document failed extraction outright — the ` +
        `rule book cannot be considered complete until this is resolved.`,
    );
  }
  const isStable = result.rejectedGroups.length === 0 && result.failedChunks === 0;
  lines.push(isStable ? "The rule book is stable." : "The rule book remains in draft.");
  return lines.join(" ");
}

function formatRulebookFailure(slug: string, error: string): string {
  return `Rule book "${slug}" failed: ${error}.`;
}

/** Shadow's per-conversation handle: one `AgenticSession`, reused for every `sendMessage` call (D6). Create via `ShadowAgent.startConversation`. */
export class ShadowConversation {
  private readonly conversationId: string;
  private session: AgenticSession | undefined;

  constructor(
    private readonly deps: ShadowAgentDeps,
    private readonly volume: VolumeSlug,
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
      if (
        directives.research.length === 0 &&
        directives.chapters.length === 0 &&
        directives.rulebooks.length === 0
      ) {
        return;
      }

      const followUps: string[] = [];
      for (const directive of directives.research) {
        for await (const event of this.runResearchDirective(directive, followUps)) {
          yield event;
        }
      }
      for (const directive of directives.chapters) {
        for await (const event of this.runChapterDirective(directive, followUps)) {
          yield event;
        }
      }
      for (const directive of directives.rulebooks) {
        for await (const event of this.runRulebookDirective(directive, followUps)) {
          yield event;
        }
      }

      prompt = followUps.join("\n\n");
    }

    throw new AutoTurnBudgetExceededError(maxAutoTurns);
  }

  private async *runResearchDirective(
    directive: ResearchDirective,
    followUps: string[],
  ): AsyncGenerator<ShadowEvent, void, undefined> {
    const brief = toResearchBrief(this.volume, directive);
    yield { type: "research-started", brief };
    try {
      const result = await this.deps.researchBriefPort.research(brief);
      yield { type: "research-completed", brief, result };
      followUps.push(formatResearchResult(brief, result));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: "research-failed", brief, error: message };
      followUps.push(formatResearchFailure(brief, message));
    }
  }

  private async *runChapterDirective(
    directive: ChapterDirective,
    followUps: string[],
  ): AsyncGenerator<ShadowEvent, void, undefined> {
    let slug: ChapterSlug;
    try {
      const draft = await draftChapter(this.deps, this.volume, directive);
      slug = draft.chapter.slug;
      yield { type: "chapter-drafted", volume: this.volume, chapter: slug };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: "error", error: `Could not draft chapter "${directive.slug}": ${message}` };
      followUps.push(formatChapterDraftFailure(directive.slug, message));
      return;
    }

    const result = await publishChapter(this.deps, this.volume, slug);
    const issues = result.outcomes.flatMap((outcome) => outcome.issues);
    yield {
      type: "chapter-audit",
      volume: this.volume,
      chapter: slug,
      passed: result.verdict.passed,
      repairs: result.repairs,
    };
    if (result.published) {
      yield { type: "chapter-published", volume: this.volume, chapter: slug };
    } else {
      yield { type: "chapter-rejected", volume: this.volume, chapter: slug, issues };
    }
    followUps.push(formatChapterOutcome(slug, result.published, issues, result.repairs));
  }

  private async *runRulebookDirective(
    directive: RulebookDirective,
    followUps: string[],
  ): AsyncGenerator<ShadowEvent, void, undefined> {
    const brief = toRulebookBrief(directive);
    for await (const event of this.deps.ruleBookPort.create(brief)) {
      switch (event.type) {
        case "started":
          yield { type: "rulebook-started", slug: event.slug, docPath: event.docPath };
          break;
        case "planned":
          yield {
            type: "rulebook-planned",
            slug: directive.slug,
            chunkCount: event.chunkCount,
            groups: event.groups,
          };
          break;
        case "chunk-extracted":
          yield {
            type: "rulebook-chunk",
            slug: directive.slug,
            completed: event.completed,
            total: event.total,
            rulesSoFar: event.rulesSoFar,
            cached: event.cached,
            failed: event.failed,
          };
          break;
        case "merged":
          yield {
            type: "rulebook-merged",
            slug: directive.slug,
            ruleCount: event.ruleCount,
            droppedQuotes: event.droppedQuotes,
            consolidated: event.consolidated,
          };
          break;
        case "group-audited":
          yield {
            type: "rulebook-group-audited",
            slug: directive.slug,
            group: event.group,
            passed: event.passed,
            repairs: event.repairs,
            issues: event.issues,
          };
          break;
        case "completed":
          yield { type: "rulebook-completed", slug: directive.slug, result: event.result };
          followUps.push(formatRulebookCompletion(event.result));
          break;
        case "failed":
          // A port-level `failed` event is data, not a thrown error — the
          // turn continues with a failure follow-up rather than aborting.
          yield { type: "rulebook-failed", slug: directive.slug, error: event.error };
          followUps.push(formatRulebookFailure(directive.slug, event.error));
          break;
      }
    }
  }

  private async getOrCreateSession(): Promise<AgenticSession> {
    if (this.session) return this.session;

    const cwd = this.deps.sessionCwd ?? join(homedir(), ".shadow");
    await ensureWritingVolumesSkillInstalled(cwd);

    // This options literal's shape (cwd/systemPrompt/skills/settingSources/
    // allowedTools/disallowedTools/permissionMode) is mirrored by hand in
    // `@shadow/model`'s `bedrock-agentic-session.test.ts` "conversation-harness
    // proof" test — update both together.
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

/** Top-level factory: holds Shadow's injected collaborators and mints a `ShadowConversation` per conversation. */
export class ShadowAgent {
  constructor(private readonly deps: ShadowAgentDeps) {}

  startConversation(volume: VolumeSlug, options?: StartConversationOptions): ShadowConversation {
    return new ShadowConversation(this.deps, volume, options);
  }
}
