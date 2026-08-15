/**
 * `@shadow/rulebook` — the Rule Book Creator pipeline: ingest → chunk →
 * taxonomy → parallel extraction → validate → merge → per-group audit →
 * publish. This package holds only the pure, LLM-free, I/O-free parts plus
 * the public port types; ingestion and the LLM-backed structured calls
 * live in `ingest.ts`/`extraction.ts`/`taxonomy.ts`/`finalize-groups.ts`,
 * and publishing happens over `@shadow/core`'s `RulebookStore`.
 */

// ---- public seam -------------------------------------------------------------

export type { RulebookBrief, RulebookEvent, RulebookResult, RuleBookPort } from "./port.ts";

// ---- chunking (raw text — see chunker.ts's module doc for why) ---------------

export type { ChunkOptions, DocumentChunk } from "./chunker.ts";
export { chunkDocument, DEFAULT_MAX_TOKENS, DEFAULT_TARGET_TOKENS } from "./chunker.ts";

// ---- structured-call schemas ---------------------------------------------------

export type {
  ExtractedRule,
  ExtractionResult,
  GroupAssignment,
  GroupFinalizationResult,
  TaxonomyGroup,
  TaxonomyResult,
} from "./schemas.ts";
export {
  DEFAULT_MAX_GROUPS,
  extractionSchema,
  GROUP_SLUG_PATTERN,
  groupFinalizationSchema,
  taxonomySchema,
} from "./schemas.ts";

// ---- validation (normalized-quote binding predicate — see validate.ts's module doc) --

export type { ValidatedRule, ValidationResult } from "./validate.ts";
export { validateChunkRules } from "./validate.ts";

// ---- consolidation --------------------------------------------------------------

export type { ConsolidatedRule } from "./merge.ts";
export { consolidateRules } from "./merge.ts";

// ---- labels -----------------------------------------------------------------

export { disambiguateLabels, ruleLabel } from "./labels.ts";

// ---- errors -----------------------------------------------------------------

export {
  DocumentDecodeError,
  DocumentNotFoundError,
  DocumentTooLargeError,
  DocumentUnsupportedError,
  GroupHasNoClaimsError,
  ShadowRulebookError,
} from "./errors.ts";

// ---- ingestion (file I/O — see ingest.ts's module doc and no-io.test.ts's whitelist) --

export type { IngestedDocument } from "./ingest.ts";
export { ingestDocument, MAX_DOCUMENT_BYTES } from "./ingest.ts";

// ---- taxonomy (structured call over the chunked outline) ----------------------

export type { PlanTaxonomyArgs, PlanTaxonomyDeps, PlanTaxonomyResult } from "./taxonomy.ts";
export { GENERAL_GROUP_SLUG, planTaxonomy, TAXONOMY_PROMPT_VERSION } from "./taxonomy.ts";

// ---- extraction (structured call per chunk) ------------------------------------

export type { ExtractChunkArgs, ExtractChunkDeps, ExtractChunkResult } from "./extraction.ts";
export { extractChunk, PROMPT_VERSION } from "./extraction.ts";

// ---- group finalization (structured call reconciling rules against the taxonomy) --

export type {
  FinalizeGroupsArgs,
  FinalizeGroupsDeps,
  FinalizeGroupsResult,
} from "./finalize-groups.ts";
export {
  DEFAULT_MAX_RULES_PER_GROUP,
  FINALIZE_BATCH_SIZE,
  FINALIZE_PROMPT_VERSION,
  finalizeGroups,
} from "./finalize-groups.ts";

// ---- assembly (consolidated rules -> group document + claim sidecar) ----------

export type { AssembleGroupArgs, AssembleGroupDeps, AssembleGroupResult } from "./assembly.ts";
export { assembleGroup } from "./assembly.ts";

// ---- publish-group (the Chain-of-Evidence audit gate for one group) -----------

export type { PublishGroupDeps, PublishGroupResult } from "./publish-group.ts";
export { publishGroup } from "./publish-group.ts";

// ---- the tool agent (the one real RuleBookPort implementation) ----------------

export type { RulebookToolAgentDeps } from "./rulebook-tool-agent.ts";
export { RulebookToolAgent } from "./rulebook-tool-agent.ts";
