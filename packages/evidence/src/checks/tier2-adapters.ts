/**
 * Concrete Tier 2 port implementations, backed by `@shadow/model`'s
 * `StructuredGenerationPort` (Zod-typed, tool-less — D5). This is the one
 * file in `@shadow/evidence` that imports `@shadow/model`; everything else
 * in `checks/` depends only on the port *interfaces* in `../ports.ts`, so
 * swapping the adapter (or, in tests, using `FakeStructuredGenerationPort`)
 * never touches check logic.
 *
 * **Every class here makes exactly one `generate()` call per invocation,
 * batched over its whole input array** via a length-pinned Zod array
 * schema (`z.array(...).length(inputs.length)`) — that pin is what lets a
 * caller trust the response lines up with the request by index without a
 * separate correlation id, and what makes a malformed/truncated model
 * response fail schema validation instead of silently misaligning. This is
 * D20's entire cost mechanism at the model-call boundary: the orchestrator
 * in `tier2.ts` decides *what* needs judging (via `inputHash`/sentence-hash
 * memoization); these adapters decide *how many calls* that costs, and the
 * answer is always one.
 */

import type { StructuredGenerationPort } from "@shadow/model";
import { z } from "zod";
import type {
  CheckWorthinessClassifier,
  CheckWorthinessInput,
  CheckWorthinessVerdict,
  ClaimRestater,
  EntailmentRelevanceInput,
  EntailmentRelevanceJudge,
  EntailmentRelevanceVerdict,
  IndexAlignmentChecker,
  IndexAlignmentInput,
  IndexAlignmentVerdict,
  RestatementCandidateInput,
  RestatementProposal,
} from "../ports.ts";

export interface AdapterOptions {
  /** Override the adapter's default model for this port — e.g. a stronger model for judging, cheaper for the check-worthiness sweep. */
  readonly model?: string;
}

// ---- C1b — check-worthiness sweep -----------------------------------------

const checkWorthinessVerdictSchema = z.object({
  checkRequired: z.boolean(),
  rationale: z.string(),
});

const CHECK_WORTHINESS_SYSTEM =
  "You audit a Shadow volume chapter for undisclosed claims (C1b, docs/EVIDENCE.md). " +
  "For each sentence below, decide independently whether it makes a checkable, " +
  "empirical assertion that would need a citation — regardless of whether the writer " +
  "cited it. Connective prose, transitions, the operator's stated preferences, and " +
  "purely definitional statements are not check-worthy. Specific factual claims about " +
  "the world (what a product does, a number, a named source's position) are. Silence " +
  "is exactly what you are auditing: judge every sentence on its own text alone.";

function buildCheckWorthinessPrompt(inputs: readonly CheckWorthinessInput[]): string {
  const items = inputs
    .map(
      (input, i) =>
        `${i + 1}. Chapter subject: ${input.chapterSubject}\n   Paragraph context: ${input.context}\n   Sentence to classify: ${input.sentence}`,
    )
    .join("\n\n");
  return `Classify each of the following ${inputs.length} sentence(s) independently. Return exactly ${inputs.length} verdict(s), one per sentence, in the same order.\n\n${items}`;
}

export class BatchedCheckWorthinessClassifier implements CheckWorthinessClassifier {
  constructor(
    private readonly port: StructuredGenerationPort,
    private readonly options: AdapterOptions = {},
  ) {}

  async classify(
    inputs: readonly CheckWorthinessInput[],
  ): Promise<readonly CheckWorthinessVerdict[]> {
    if (inputs.length === 0) return [];
    const schema = z.object({
      verdicts: z.array(checkWorthinessVerdictSchema).length(inputs.length),
    });
    const { object } = await this.port.generate({
      schema,
      prompt: buildCheckWorthinessPrompt(inputs),
      system: CHECK_WORTHINESS_SYSTEM,
      schemaName: "check_worthiness_sweep",
      schemaDescription: "One check-worthiness verdict per input sentence, in order (C1b).",
      model: this.options.model,
    });
    return object.verdicts;
  }
}

// ---- C3 + C5 — span entailment and relevance, one prompt turn (D15) -------

const VERIFICATION_STATUS_VALUES = ["supported", "partial", "unsupported", "conflicted"] as const;
const OVERGENERALIZATION_RISK_VALUES = ["low", "medium", "high"] as const;
const RELEVANCE_VALUES = ["on-topic", "off-topic"] as const;

const entailmentVerdictSchema = z.object({
  status: z.enum(VERIFICATION_STATUS_VALUES),
  rationale: z.string(),
  conflictsWith: z.array(z.string()).optional(),
  overgeneralizationRisk: z.enum(OVERGENERALIZATION_RISK_VALUES).optional(),
});

const relevanceVerdictSchema = z.object({
  relevance: z.enum(RELEVANCE_VALUES),
  rationale: z.string(),
});

const entailmentRelevanceVerdictSchema = z.object({
  entailment: entailmentVerdictSchema,
  relevance: relevanceVerdictSchema,
});

const ENTAILMENT_RELEVANCE_SYSTEM =
  "You judge claims in a Shadow volume chapter against their cited evidence (C3, and " +
  "chapter relevance C5, docs/EVIDENCE.md). For each claim, decide two independent " +
  "things: (1) entailment — does the cited evidence support the decontextualized claim " +
  "exactly as stated, no more? For a claim with `supportingClaims` instead of source " +
  "candidates, does the claim follow from those supporting claims without generalizing " +
  "beyond what they jointly establish — report high overgeneralizationRisk if it reaches " +
  "further than its supports justify. Use `unsupported` when the evidence says nothing " +
  "relevant, `partial` when it supports part of the claim but not all of it, `conflicted` " +
  "when candidates disagree with each other. (2) relevance — does this claim serve the " +
  "chapter's stated subject (and when_to_use, if given), independent of whether it is " +
  "grounded? A claim can be perfectly supported by its evidence and still be off-topic.";

function buildEntailmentRelevancePrompt(inputs: readonly EntailmentRelevanceInput[]): string {
  const items = inputs
    .map((input, i) => {
      const candidates =
        input.candidates.length > 0
          ? input.candidates.map((c, j) => `     candidate ${j + 1}: "${c.exact}"`).join("\n")
          : "     (none — derived claim, judge against supportingClaims below)";
      const supports = input.supportingClaims?.length
        ? `\n   Supporting claims:\n${input.supportingClaims.map((s, j) => `     ${j + 1}. ${s}`).join("\n")}`
        : "";
      return (
        `${i + 1}. Chapter subject: ${input.chapterSubject}\n` +
        (input.whenToUse ? `   When to use this chapter: ${input.whenToUse}\n` : "") +
        `   Claim: ${input.decontextualized}\n` +
        `   Evidence candidates:\n${candidates}${supports}`
      );
    })
    .join("\n\n");
  return `Judge each of the following ${inputs.length} claim(s) independently. Return exactly ${inputs.length} verdict(s) (entailment + relevance), one per claim, in the same order.\n\n${items}`;
}

export class BatchedEntailmentRelevanceJudge implements EntailmentRelevanceJudge {
  constructor(
    private readonly port: StructuredGenerationPort,
    private readonly options: AdapterOptions = {},
  ) {}

  async judge(
    inputs: readonly EntailmentRelevanceInput[],
  ): Promise<readonly EntailmentRelevanceVerdict[]> {
    if (inputs.length === 0) return [];
    const schema = z.object({
      verdicts: z.array(entailmentRelevanceVerdictSchema).length(inputs.length),
    });
    const { object } = await this.port.generate({
      schema,
      prompt: buildEntailmentRelevancePrompt(inputs),
      system: ENTAILMENT_RELEVANCE_SYSTEM,
      schemaName: "span_entailment_and_relevance",
      schemaDescription:
        "One combined entailment (C3) + relevance (C5) verdict per input claim, in order.",
      model: this.options.model,
    });
    return object.verdicts;
  }
}

// ---- C4 — index alignment ---------------------------------------------------

const indexAlignmentVerdictSchema = z.object({
  aligned: z.boolean(),
  unsupportedAssertions: z.array(z.string()),
});

const INDEX_ALIGNMENT_SYSTEM =
  "You audit an index node's routing metadata against the chapter it points to (C4, " +
  "docs/EVIDENCE.md). For each node summary / when_to_use fragment, decide whether every " +
  "claim it makes appears in, or is entailed by, the listed chapter claims. List any " +
  "assertion the summary makes that the chapter does not support as an unsupported " +
  "assertion, quoting the offending phrase from the summary.";

function buildIndexAlignmentPrompt(inputs: readonly IndexAlignmentInput[]): string {
  const items = inputs
    .map(
      (input, i) =>
        `${i + 1}. Node summary: ${input.nodeSummary}\n   Chapter claims:\n${input.chapterClaims
          .map((c, j) => `     ${j + 1}. ${c}`)
          .join("\n")}`,
    )
    .join("\n\n");
  return `Check each of the following ${inputs.length} routing-metadata fragment(s) independently. Return exactly ${inputs.length} verdict(s), one per fragment, in the same order.\n\n${items}`;
}

export class BatchedIndexAlignmentChecker implements IndexAlignmentChecker {
  constructor(
    private readonly port: StructuredGenerationPort,
    private readonly options: AdapterOptions = {},
  ) {}

  async check(inputs: readonly IndexAlignmentInput[]): Promise<readonly IndexAlignmentVerdict[]> {
    if (inputs.length === 0) return [];
    const schema = z.object({
      verdicts: z.array(indexAlignmentVerdictSchema).length(inputs.length),
    });
    const { object } = await this.port.generate({
      schema,
      prompt: buildIndexAlignmentPrompt(inputs),
      system: INDEX_ALIGNMENT_SYSTEM,
      schemaName: "index_alignment",
      schemaDescription: "One index-alignment verdict per routing-metadata fragment, in order.",
      model: this.options.model,
    });
    return object.verdicts;
  }
}

// ---- Repair loop — restatement proposals -----------------------------------

const restatementProposalSchema = z.object({
  to: z.string(),
  reason: z.string(),
});

const RESTATEMENT_SYSTEM =
  "You conservatively restate claims in a Shadow volume chapter to match what their " +
  "evidence actually supports (D9/D21, docs/EVIDENCE.md). Rewrite each claim to the " +
  "narrowest scope its cited evidence excerpts justify — never expand it, never invent " +
  "detail the evidence does not contain. For a `conflicted` claim, surface both positions " +
  "explicitly ('X holds A, while Y holds B') rather than picking a side. Stay as close to " +
  "the original wording as the correction allows — you are trimming an overclaim, not " +
  "rewriting the sentence from scratch. State your reason for each change concisely.";

function buildRestatementPrompt(inputs: readonly RestatementCandidateInput[]): string {
  const items = inputs
    .map(
      (input, i) =>
        `${i + 1}. Verdict: ${input.verdict}\n   Original sentence: ${input.text}\n   Evidence excerpts:\n${input.evidenceExcerpts
          .map((e, j) => `     ${j + 1}. ${e}`)
          .join("\n")}`,
    )
    .join("\n\n");
  return `Propose a conservative restatement for each of the following ${inputs.length} claim(s). Return exactly ${inputs.length} proposal(s), one per claim, in the same order.\n\n${items}`;
}

export class BatchedClaimRestater implements ClaimRestater {
  constructor(
    private readonly port: StructuredGenerationPort,
    private readonly options: AdapterOptions = {},
  ) {}

  async restate(
    inputs: readonly RestatementCandidateInput[],
  ): Promise<readonly RestatementProposal[]> {
    if (inputs.length === 0) return [];
    const schema = z.object({
      proposals: z.array(restatementProposalSchema).length(inputs.length),
    });
    const { object } = await this.port.generate({
      schema,
      prompt: buildRestatementPrompt(inputs),
      system: RESTATEMENT_SYSTEM,
      schemaName: "claim_restatement",
      schemaDescription: "One conservative restatement proposal per input claim, in order.",
      model: this.options.model,
    });
    return object.proposals;
  }
}
