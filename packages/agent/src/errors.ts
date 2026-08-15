/**
 * Typed error hierarchy for @shadow/agent.
 *
 * Every failure mode a caller needs to branch on has its own class with
 * structured fields (never just a string). `instanceof` checks against
 * these — not string-matching `error.message` — is the supported way to
 * handle them. Mirrors the convention established in `@shadow/core`,
 * `@shadow/research`, and `@shadow/evidence`.
 */

/**
 * `UnknownSourceError` and `UnresolvedEvidenceQuoteError` used to be defined
 * here, but moved to `@shadow/evidence`'s `errors.ts` alongside
 * `buildSpanFromQuote` (`span-binding.ts`) when the span builder was lifted
 * out of this package (Rule Book Creator) — the errors belong with
 * the code that throws them. Re-exported here so existing callers/tests
 * importing them from `@shadow/agent`'s errors module are unaffected.
 */
export { UnknownSourceError, UnresolvedEvidenceQuoteError } from "@shadow/evidence";

/** Base class for every error this package throws. */
export abstract class ShadowAgentError extends Error {
  abstract override readonly name: string;
}

/**
 * Copying `skills/shadow-write-volumes/SKILL.md` (T3.2) into a session's
 * `.claude/skills/` directory failed — e.g. the canonical monorepo skill
 * file could not be read, or the destination could not be written. Shadow
 * refuses to start a conversation without this: "genuinely skill-guided"
 * (acceptance) means the skill file must actually be on disk where the
 * session looks for it, not merely referenced in a system prompt.
 */
export class SkillInstallError extends ShadowAgentError {
  override readonly name = "SkillInstallError";

  constructor(
    public readonly skill: string,
    public readonly sourcePath: string,
    cause?: unknown,
  ) {
    super(`Could not install skill "${skill}" from ${JSON.stringify(sourcePath)}`, { cause });
  }
}

/**
 * A ```shadow:research```, ```shadow:chapter```, or ```shadow:rulebook```
 * fenced block in Shadow's own turn text was not valid JSON, or did not
 * match the expected shape. This is Shadow (the model) misusing its own
 * protocol, not an operator error — surfaced distinctly so a caller can log
 * it and feed the reason back for a retry.
 */
export class MalformedDirectiveError extends ShadowAgentError {
  override readonly name = "MalformedDirectiveError";

  constructor(
    public readonly kind: "research" | "chapter" | "rulebook",
    public readonly raw: string,
    public readonly reason: string,
  ) {
    super(`Malformed shadow:${kind} directive: ${reason}`);
  }
}

/**
 * A `sourced` or `operator` claim in a chapter directive carried no
 * `evidence[]` entries, or a `derived` claim carried no `supports[]` — the
 * writer's own directive failed to do what D19 requires before this package
 * ever touches the evidence ledger. Mirrors what C1a would catch later at
 * audit time, but catching it here means a directly-actionable message goes
 * straight back to Shadow's next turn instead of a chapter silently getting
 * drafted with a claim that can never resolve.
 */
export class ClaimMissingRequiredFieldError extends ShadowAgentError {
  override readonly name = "ClaimMissingRequiredFieldError";

  constructor(
    public readonly label: string,
    public readonly kind: "sourced" | "derived" | "operator",
    public readonly field: "evidence" | "supports",
  ) {
    super(`Claim "${label}" (${kind}) has no ${field}[] — required before it can be drafted`);
  }
}

/** `publishChapter` was called for a chapter that has never been drafted (no claim sidecar exists yet). */
export class ChapterHasNoClaimsError extends ShadowAgentError {
  override readonly name = "ChapterHasNoClaimsError";

  constructor(
    public readonly volume: string,
    public readonly chapter: string,
  ) {
    super(`Chapter "${chapter}" in volume "${volume}" has no claim sidecar — draft it first`);
  }
}

/** The agentic session's turn reported `isError: true` — a transport/process-level failure, distinct from a normal conversational reply. */
export class ShadowTurnFailedError extends ShadowAgentError {
  override readonly name = "ShadowTurnFailedError";

  constructor(
    public readonly stopReason: string | null,
    public readonly text: string,
  ) {
    super(
      `Shadow's turn failed (stopReason: ${JSON.stringify(stopReason)}): ${text || "(no text)"}`,
    );
  }
}

/**
 * `sendMessage`'s auto-continuation loop (delegating research, drafting
 * chapters, feeding results back for another turn) ran for
 * `maxAutoTurns` turns without Shadow producing a turn with no further
 * directives. Bounded deliberately — an unbounded loop would let a
 * misbehaving model spend the operator's subscription indefinitely.
 */
export class AutoTurnBudgetExceededError extends ShadowAgentError {
  override readonly name = "AutoTurnBudgetExceededError";

  constructor(public readonly maxAutoTurns: number) {
    super(
      `Reached the auto-turn budget (${maxAutoTurns}) without Shadow producing a turn with no ` +
        `further directives — refusing to continue indefinitely.`,
    );
  }
}
