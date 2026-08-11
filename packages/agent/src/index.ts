/**
 * @shadow/agent — Shadow, the shadow writer (`ARCHITECTURE.md`).
 *
 * The user-facing chat agent, and the only agent the operator speaks to.
 * Orchestrates: interprets intent over a reused `AgenticSession` (D6),
 * delegates research to `ResearchBriefPort` (never fetches itself), drafts
 * chapters under skill guidance with evidence bound before writing, gates
 * publication behind `@shadow/evidence`'s CoE audit with conservative
 * repair (D9/D21), and triggers `@shadow/indexing`'s zero-LLM reindex.
 *
 * **Invariant this package exists to enforce:** Shadow writes only what it
 * can cite. Every collaborator is injected as an interface
 * (`ShadowAgentDeps`) — this package depends on ports, never on a concrete
 * implementation, and never imports an AI SDK (only `@shadow/model`'s
 * ports).
 */

export type { ChapterDraft, ChapterDraftDeps } from "./chapter-draft.ts";
export { draftChapter } from "./chapter-draft.ts";
export type {
  ShadowAgentDeps,
  ShadowEvent,
  StartConversationOptions,
} from "./conversation.ts";
export { ShadowAgent, ShadowConversation } from "./conversation.ts";
export type {
  ChapterClaimDirective,
  ChapterClaimEvidenceInput,
  ChapterDirective,
  ClaimKindDirective,
  ParsedDirectives,
  ResearchDirective,
} from "./directives.ts";
export { parseShadowDirectives } from "./directives.ts";
export {
  AutoTurnBudgetExceededError,
  ChapterHasNoClaimsError,
  ClaimMissingRequiredFieldError,
  MalformedDirectiveError,
  ShadowAgentError,
  ShadowTurnFailedError,
  SkillInstallError,
  UnknownSourceError,
  UnresolvedEvidenceQuoteError,
} from "./errors.ts";
export type { PublishDeps, PublishResult } from "./publish.ts";
export { publishChapter } from "./publish.ts";
export type { EnsureSkillInstalledResult } from "./skills.ts";
export { ensureWritingVolumesSkillInstalled } from "./skills.ts";
export {
  buildShadowSystemPrompt,
  CHAPTER_DIRECTIVE_TAG,
  RESEARCH_DIRECTIVE_TAG,
} from "./system-prompt.ts";
