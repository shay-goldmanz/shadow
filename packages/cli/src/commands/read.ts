/**
 * `shadow read <node_id> [--with-parents]` (`docs/INDEXING.md`, STAGE 4
 * READ): body bytes from the node's span, heading path, and content_hash —
 * plus, with `--with-parents`, the parent's `when_to_use` and sibling
 * titles. Thin CLI wrapper over `@shadow/indexing`'s `readNode` +
 * `resolveReadContext`; all the structural work happens there.
 */

import type { VolumeStore } from "@shadow/core";
import { NodeNotFoundError, readNode } from "@shadow/indexing";
import { NodeLookupError } from "../errors.ts";
import { loadCorpusIndex } from "../loaders.ts";

export interface ReadOptions {
  readonly withParents: boolean;
}

export interface ReadResult {
  readonly node_id: string;
  readonly body: string;
  readonly heading_path: readonly string[];
  readonly content_hash: string;
  readonly parent_when_to_use?: string;
  readonly sibling_titles?: readonly string[];
  /** OKF v0.2 fields. */
  readonly okf: {
    readonly type: string;
    readonly status: string;
    readonly stale_after: string | null;
    readonly generated_by: string;
    readonly generated_at: string;
    readonly verified: readonly { by: string; at: string }[];
  };
  readonly next_steps: readonly string[];
}

function nextSteps(
  nodeId: string,
  contentHash: string,
  staleAfter: string | null,
): readonly string[] {
  const steps: string[] = [
    `Cite this content with node_id "${nodeId}" and content_hash "${contentHash}" if you use it.`,
    "If this fully answers the task, you're done — no need to call `shadow find` again.",
    `Otherwise, call \`shadow find "<task>" --visited ${nodeId}\` to keep looking.`,
  ];
  if (staleAfter && new Date(staleAfter) < new Date()) {
    steps.push(
      `⚠️ This content is stale (stale_after: ${staleAfter}). Treat its guidance as possibly out of date.`,
    );
  }
  return steps;
}

export async function runRead(
  store: VolumeStore,
  nodeId: string,
  options: ReadOptions,
): Promise<ReadResult> {
  const document = await loadCorpusIndex(store);
  let result: Awaited<ReturnType<typeof readNode>>;
  try {
    result = await readNode(store, document, nodeId);
  } catch (error) {
    if (error instanceof NodeNotFoundError) {
      throw new NodeLookupError(error);
    }
    throw error;
  }

  const parents = options.withParents
    ? {
        parent_when_to_use: result.parent_when_to_use,
        sibling_titles: result.sibling_titles,
      }
    : {};

  return {
    node_id: result.node_id,
    body: result.body,
    heading_path: result.heading_path,
    content_hash: result.content_hash,
    okf: {
      type: result.type,
      status: result.status,
      stale_after: result.stale_after,
      generated_by: result.generated_by,
      generated_at: result.generated_at,
      verified: result.verified,
    },
    ...parents,
    next_steps: nextSteps(result.node_id, result.content_hash, result.stale_after),
  };
}
