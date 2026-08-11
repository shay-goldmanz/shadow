/**
 * Typed error hierarchy for @shadow/agent.
 *
 * Every failure mode a caller needs to branch on has its own class with
 * structured fields (never just a string). `instanceof` checks against
 * these — not string-matching `error.message` — is the supported way to
 * handle them. Mirrors the convention established in `@shadow/core`,
 * `@shadow/research`, and `@shadow/evidence`.
 */

/** Base class for every error this package throws. */
export abstract class ShadowAgentError extends Error {
  abstract override readonly name: string;
}

/**
 * Copying `skills/writing-volumes/SKILL.md` (T3.2) into a session's
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
 * A ```shadow:research``` or ```shadow:chapter``` fenced block in Shadow's
 * own turn text was not valid JSON, or did not match the expected shape.
 * This is Shadow (the model) misusing its own protocol, not an operator
 * error — surfaced distinctly so a caller can log it and feed the reason
 * back for a retry.
 */
export class MalformedDirectiveError extends ShadowAgentError {
  override readonly name = "MalformedDirectiveError";

  constructor(
    public readonly kind: "research" | "chapter",
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

/** A claim directive cited a `sourceId` that does not resolve in this volume's evidence ledger — Shadow cannot bind evidence to a source it (or the operator) never actually produced. */
export class UnknownSourceError extends ShadowAgentError {
  override readonly name = "UnknownSourceError";

  constructor(
    public readonly label: string,
    public readonly sourceId: string,
    cause?: unknown,
  ) {
    super(`Claim "${label}" cites source ${JSON.stringify(sourceId)}, which does not exist`, {
      cause,
    });
  }
}

/**
 * A claim directive's `quote` is not an exact substring of the cited
 * source's current snapshot text. Bind-before-write (D19, the
 * writing-volumes skill's §4): Shadow must copy verbatim from what research
 * or the operator transcript actually returned, never paraphrase and hope.
 */
export class UnresolvedEvidenceQuoteError extends ShadowAgentError {
  override readonly name = "UnresolvedEvidenceQuoteError";

  constructor(
    public readonly label: string,
    public readonly sourceId: string,
    public readonly quote: string,
  ) {
    super(
      `Claim "${label}"'s quote does not appear verbatim in source ${JSON.stringify(
        sourceId,
      )}'s snapshot: ${JSON.stringify(quote)}`,
    );
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
