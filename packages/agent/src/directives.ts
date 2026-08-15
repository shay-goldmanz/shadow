/**
 * Parses the two fenced-JSON directives (`system-prompt.ts`) out of one of
 * Shadow's turns. Pure text-in, typed-directives-out — no I/O, no model, no
 * store — so this is unit-testable on its own with plain strings.
 *
 * A directive is Shadow's own output, not the operator's, so a malformed
 * one is a bug in Shadow's reply (bad JSON, a missing required field) —
 * `MalformedDirectiveError` carries the raw block text so a caller can log
 * it and feed the reason back on the next turn for Shadow to fix.
 */

import { GROUP_SLUG_PATTERN } from "@shadow/rulebook";
import { z } from "zod";
import { MalformedDirectiveError } from "./errors.ts";
import { RESEARCH_DIRECTIVE_TAG, RULEBOOK_DIRECTIVE_TAG } from "./system-prompt.ts";

const claimKindSchema = z.enum(["sourced", "derived", "operator"]);
const confidenceSchema = z.enum(["high", "medium", "provisional"]);

const evidenceRefSchema = z.object({
  sourceId: z.string().min(1),
  quote: z.string().min(1),
});

const claimDirectiveSchema = z.object({
  label: z.string().min(1),
  kind: claimKindSchema,
  text: z.string().min(1),
  decontextualized: z.string().min(1).optional(),
  evidence: z.array(evidenceRefSchema).optional(),
  supports: z.array(z.string().min(1)).optional(),
});

const researchDirectiveSchema = z.object({
  goal: z.string().min(1),
  subjectDomains: z.array(z.string().min(1)).optional(),
  constraints: z.array(z.string().min(1)).optional(),
  maxSources: z.number().int().positive().optional(),
});

const chapterFrontmatterSchema = z.object({
  when_to_use: z.string().min(1).optional(),
  not_for: z.string().min(1).optional(),
  keywords: z.array(z.string().min(1)).optional(),
  confidence: confidenceSchema.optional(),
});

const okfStatusSchema = z.enum(["draft", "stable", "deprecated"]);

const chapterOkfSchema = z.object({
  type: z.string().min(1).optional(),
  status: okfStatusSchema.optional(),
});

const chapterDirectiveSchema = z.object({
  slug: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  frontmatter: chapterFrontmatterSchema.optional(),
  okf: chapterOkfSchema.optional(),
  claims: z.array(claimDirectiveSchema),
});

const rulebookDirectiveSchema = z.object({
  slug: z.string().regex(GROUP_SLUG_PATTERN),
  title: z.string().min(1),
  docPath: z.string().min(1),
  scope: z.string().optional(),
  constraints: z.array(z.string().min(1)).optional(),
  maxGroups: z.number().int().positive().max(32).optional(),
});

export type ClaimKindDirective = z.infer<typeof claimKindSchema>;
export type ChapterClaimEvidenceInput = z.infer<typeof evidenceRefSchema>;
export type ChapterClaimDirective = z.infer<typeof claimDirectiveSchema>;
export type ResearchDirective = z.infer<typeof researchDirectiveSchema>;
export type ChapterDirective = z.infer<typeof chapterDirectiveSchema>;
export type RulebookDirective = z.infer<typeof rulebookDirectiveSchema>;

export interface ParsedDirectives {
  readonly research: readonly ResearchDirective[];
  readonly chapters: readonly ChapterDirective[];
  readonly rulebooks: readonly RulebookDirective[];
}

const DIRECTIVE_PATTERN = /```(shadow:research|shadow:chapter|shadow:rulebook)\n([\s\S]*?)\n```/g;

function zodIssuesToReason(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`)
    .join("; ");
}

/** Parse every `shadow:research`/`shadow:chapter` fenced block out of `text`, in the order they appear. */
export function parseShadowDirectives(text: string): ParsedDirectives {
  const research: ResearchDirective[] = [];
  const chapters: ChapterDirective[] = [];
  const rulebooks: RulebookDirective[] = [];

  for (const match of text.matchAll(DIRECTIVE_PATTERN)) {
    const tag = match[1];
    const raw = match[2] ?? "";
    const kind: "research" | "chapter" | "rulebook" =
      tag === RESEARCH_DIRECTIVE_TAG
        ? "research"
        : tag === RULEBOOK_DIRECTIVE_TAG
          ? "rulebook"
          : "chapter";

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new MalformedDirectiveError(
        kind,
        raw,
        `invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    if (kind === "research") {
      const result = researchDirectiveSchema.safeParse(parsed);
      if (!result.success) {
        throw new MalformedDirectiveError(kind, raw, zodIssuesToReason(result.error));
      }
      research.push(result.data);
    } else if (kind === "rulebook") {
      const result = rulebookDirectiveSchema.safeParse(parsed);
      if (!result.success) {
        throw new MalformedDirectiveError(kind, raw, zodIssuesToReason(result.error));
      }
      rulebooks.push(result.data);
    } else {
      const result = chapterDirectiveSchema.safeParse(parsed);
      if (!result.success) {
        throw new MalformedDirectiveError(kind, raw, zodIssuesToReason(result.error));
      }
      chapters.push(result.data);
    }
  }

  return { research, chapters, rulebooks };
}
