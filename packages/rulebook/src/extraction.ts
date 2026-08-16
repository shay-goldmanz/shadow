/**
 * The per-chunk extraction call: one structured LLM call per document
 * chunk, proposing normative rules each grounded by 1-3 verbatim quotes
 * from that chunk's text. `validate.ts` is what actually checks those
 * quotes bind to the pinned snapshot — this module's job is just driving
 * the call and memoizing its result.
 *
 * Memoized against `RulebookStore`'s extraction cache, keyed off the
 * chunk's content hash, the group menu offered, *and* the effective model
 * (`args.model ?? "default"`) — a taxonomy replan changes the menu, which
 * must invalidate every chunk's cache, not just the plan's, and a
 * different model can produce different output for byte-identical input,
 * which must invalidate the cache the same way (see `port.ts`'s
 * `RulebookBrief.extractionModel`). `PROMPT_VERSION` gives a manual escape
 * hatch: bump it when this module's prompt/instructions change
 * meaningfully, and every chunk's cache invalidates on the next run even
 * if neither the chunk, the menu, nor the model changed.
 */

import type { RulebookStore, VolumeSlug } from "@shadow/core";
import type { StructuredGenerationPort, TokenUsage } from "@shadow/model";
import { ZERO_USAGE } from "@shadow/model";
import type { DocumentChunk } from "./chunker.ts";
import {
  type ExtractedRule,
  type ExtractionResult,
  extractionSchema,
  type TaxonomyGroup,
} from "./schemas.ts";

/** Bump on a meaningful prompt/instruction change — invalidates every chunk's extraction cache. */
export const PROMPT_VERSION = "v1";

/** One retry after the first attempt fails, before giving up on this chunk. */
const MAX_ATTEMPTS = 2;

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

type GroupMenuEntry = Pick<TaxonomyGroup, "slug" | "when_to_use">;

function groupMenuText(groups: readonly GroupMenuEntry[]): string {
  return groups.map((group) => `- ${group.slug}: ${group.when_to_use}`).join("\n");
}

function extractionCacheKey(
  promptVersion: string,
  contentHash: string,
  menuHash: string,
  modelKey: string,
): string {
  return `chunk-${sha256Hex(`${promptVersion}${contentHash}${menuHash}${modelKey}`).slice(0, 24)}`;
}

export interface ExtractChunkDeps {
  readonly structuredGeneration: StructuredGenerationPort;
  readonly rulebookStore: RulebookStore;
}

export interface ExtractChunkArgs {
  readonly rulebookSlug: VolumeSlug;
  readonly chunk: DocumentChunk;
  /** The taxonomy's groups (slug + when_to_use is all this call needs) — the menu the model proposes a group from. */
  readonly groups: readonly GroupMenuEntry[];
  /** Forwarded as `StructuredGenerationRequest.model`; undefined leaves the adapter's own default in place (see `port.ts`'s `RulebookBrief.extractionModel`). Folded into the cache key. */
  readonly model?: string;
}

export interface ExtractChunkResult {
  readonly rules: readonly ExtractedRule[];
  /** Served from the extraction cache rather than a fresh call. */
  readonly cached: boolean;
  /** Both attempts failed; `rules` is empty and the caller should count this chunk as failed. */
  readonly failed: boolean;
  readonly usage: TokenUsage;
}

/**
 * Extract rules from one chunk. One structured call
 * (`schemaName: "rulebook-extraction"`) on a cache miss, with one retry on
 * failure before giving up (`failed: true`, empty rules, zero usage) —
 * never throws for a single chunk's generation failure, since the caller
 * (`rulebook-tool-agent.ts`) needs to keep processing the rest of the document.
 */
export async function extractChunk(
  deps: ExtractChunkDeps,
  args: ExtractChunkArgs,
): Promise<ExtractChunkResult> {
  const menuHash = sha256Hex(groupMenuText(args.groups));
  const modelKey = args.model ?? "default";
  const key = extractionCacheKey(PROMPT_VERSION, args.chunk.contentHash, menuHash, modelKey);

  const rawCached = await deps.rulebookStore.readExtractionCache<unknown>(args.rulebookSlug, key);
  if (rawCached) {
    // Parse failure (a hand-edited or corrupted cache file) is a cache
    // miss, not a crash — self-healing.
    const parsed = extractionSchema.safeParse(rawCached);
    if (parsed.success) {
      return { rules: parsed.data.rules, cached: true, failed: false, usage: ZERO_USAGE };
    }
  }

  const system =
    "You are extracting normative rules from one chunk of a source document for a rule book. " +
    "Each rule's statement must be exactly one self-contained normative sentence — a " +
    "requirement, prohibition, permission, or threshold — never a narrative or descriptive " +
    "sentence. Copy any numeral in the statement exactly as the source writes it (do not " +
    "reformat, round, or convert units). Every rule needs 1 to 3 quotes: verbatim substrings of " +
    "THIS chunk's text (no paraphrasing, no ellipses, no combining separate fragments), each of " +
    "which independently supports the statement on its own. Propose one group slug from the menu " +
    'below for each rule — use "general" only when the rule truly fits nowhere more specific.';

  const prompt = `Group menu:\n${groupMenuText(args.groups)}\n\nChunk text:\n${args.chunk.text}`;

  let object: ExtractionResult | undefined;
  let usage: TokenUsage = ZERO_USAGE;

  for (let attempt = 0; attempt < MAX_ATTEMPTS && !object; attempt++) {
    try {
      const result = await deps.structuredGeneration.generate({
        schema: extractionSchema,
        prompt,
        system,
        schemaName: "rulebook-extraction",
        model: args.model,
      });
      object = result.object;
      usage = result.usage;
    } catch {
      // Swallow and retry (or give up after MAX_ATTEMPTS) — a single
      // chunk's generation failure must not abort the whole pipeline.
    }
  }

  if (!object) {
    return { rules: [], cached: false, failed: true, usage: ZERO_USAGE };
  }

  await deps.rulebookStore.writeExtractionCache(args.rulebookSlug, key, object);

  return { rules: object.rules, cached: false, failed: false, usage };
}
