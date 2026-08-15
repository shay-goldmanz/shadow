/**
 * zod schemas for the pipeline's structured LLM calls. Pure schema
 * definitions only — `extraction.ts` is the one that actually drives a
 * `StructuredGenerationPort` with these; this module has no model
 * dependency and makes no calls itself.
 */

import { z } from "zod";

/** Same slug character class `@shadow/core`'s `RulebookLayout` validates group slugs against. */
export const GROUP_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const DEFAULT_MAX_GROUPS = 16;

export const taxonomyGroupSchema = z.object({
  slug: z.string().regex(GROUP_SLUG_PATTERN),
  title: z.string(),
  when_to_use: z.string(),
  not_for: z.string(),
  keywords: z.array(z.string()),
});

/**
 * The taxonomy call's output shape: a proposed set of groups (chapter-shaped
 * documents in `RulebookStore` terms) the extraction pass will file rules
 * into. `maxGroups` is per-brief (`RulebookBrief.maxGroups`, default
 * {@link DEFAULT_MAX_GROUPS}), so this is a factory rather than a static
 * schema.
 */
export function taxonomySchema(maxGroups: number = DEFAULT_MAX_GROUPS) {
  return z.object({
    groups: z.array(taxonomyGroupSchema).max(maxGroups),
  });
}

export type TaxonomyGroup = z.infer<typeof taxonomyGroupSchema>;
export type TaxonomyResult = z.infer<ReturnType<typeof taxonomySchema>>;

const extractedRuleSchema = z.object({
  statement: z.string(),
  quotes: z.array(z.string().min(8)).min(1).max(3),
  group: z.string(),
});

/** The per-chunk extraction call's output shape: rules, each with 1-3 supporting quotes and a proposed group. */
export const extractionSchema = z.object({
  rules: z.array(extractedRuleSchema),
});

export type ExtractedRule = z.infer<typeof extractedRuleSchema>;
export type ExtractionResult = z.infer<typeof extractionSchema>;

const groupAssignmentSchema = z.object({
  label: z.string(),
  group: z.string(),
});

/** Group-finalization call's output shape: the group-finalization LLM pass (`finalize-groups.ts`) reconciling each rule's proposed group against the final taxonomy. */
export const groupFinalizationSchema = z.object({
  assignments: z.array(groupAssignmentSchema),
});

export type GroupAssignment = z.infer<typeof groupAssignmentSchema>;
export type GroupFinalizationResult = z.infer<typeof groupFinalizationSchema>;
