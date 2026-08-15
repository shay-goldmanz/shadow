import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystemRulebookStore, type VolumeSlug, toVolumeSlug } from "@shadow/core";
import {
  addUsage,
  FakeStructuredGenerationPort,
  type StructuredGenerationPort,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
  type TokenUsage,
  ZERO_USAGE,
} from "@shadow/model";
import type { DocumentChunk } from "./chunker.ts";
import { extractChunk } from "./extraction.ts";

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "shadow-rulebook-extraction-test-"));
}

async function makeRulebookStore(
  slugName: string,
): Promise<{ root: string; rulebookStore: FileSystemRulebookStore; slug: VolumeSlug }> {
  const root = await makeTempRoot();
  const rulebookStore = new FileSystemRulebookStore(root);
  const slug = toVolumeSlug(slugName);
  await rulebookStore.createRulebook({ slug, title: "Extraction Test" });
  return { root, rulebookStore, slug };
}

function makeChunk(overrides: Partial<DocumentChunk> = {}): DocumentChunk {
  return {
    index: 0,
    headingPath: ["Loan Policy"],
    text: "Borrowers must repay all principal and interest within 30 days of demand.",
    tokens: 15,
    contentHash: "a".repeat(64),
    ...overrides,
  };
}

const GROUPS = [{ slug: "repayment", when_to_use: "Rules about repaying a loan." }];

const FIXTURE_EXTRACTION = {
  rules: [
    {
      statement: "Borrowers must repay all principal and interest within 30 days of demand.",
      quotes: ["repay all principal and interest within 30 days of demand"],
      group: "repayment",
    },
  ],
};

/** A `StructuredGenerationPort` test double that reports real (non-zero) usage, unlike `FakeStructuredGenerationPort`, which always reports `ZERO_USAGE` — needed to assert usage actually flows through `extractChunk` on a fresh call. */
class UsageReportingPort implements StructuredGenerationPort {
  calls = 0;

  constructor(
    private readonly object: unknown,
    private readonly usage: TokenUsage,
  ) {}

  async generate<Output>(
    request: StructuredGenerationRequest<Output>,
  ): Promise<StructuredGenerationResult<Output>> {
    this.calls += 1;
    return { object: request.schema.parse(this.object), usage: this.usage };
  }
}

/** Always fails, to exercise the one-retry-then-failed path. */
class AlwaysFailsPort implements StructuredGenerationPort {
  calls = 0;

  async generate<Output>(_request: StructuredGenerationRequest<Output>): Promise<StructuredGenerationResult<Output>> {
    this.calls += 1;
    throw new Error("simulated generation failure");
  }
}

describe("extractChunk", () => {
  test("extracts rules on a cache miss", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("extraction-miss");
    try {
      const structuredGeneration = new FakeStructuredGenerationPort([FIXTURE_EXTRACTION]);

      const result = await extractChunk(
        { structuredGeneration, rulebookStore },
        { rulebookSlug: slug, chunk: makeChunk(), groups: GROUPS },
      );

      expect(result.cached).toBe(false);
      expect(result.failed).toBe(false);
      expect(result.rules).toEqual(FIXTURE_EXTRACTION.rules);
      expect(structuredGeneration.calls).toHaveLength(1);
      expect(structuredGeneration.calls[0]?.schemaName).toBe("rulebook-extraction");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a second call for the same chunk + group menu hits the cache and skips the port", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("extraction-cache-hit");
    try {
      const structuredGeneration = new FakeStructuredGenerationPort([FIXTURE_EXTRACTION]);
      const args = { rulebookSlug: slug, chunk: makeChunk(), groups: GROUPS };

      const first = await extractChunk({ structuredGeneration, rulebookStore }, args);
      expect(first.cached).toBe(false);

      const second = await extractChunk({ structuredGeneration, rulebookStore }, args);
      expect(second.cached).toBe(true);
      expect(second.rules).toEqual(first.rules);
      expect(second.usage).toEqual(ZERO_USAGE);
      expect(structuredGeneration.calls).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a changed group menu invalidates the cache even for the same chunk", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("extraction-menu-change");
    try {
      const structuredGeneration = new FakeStructuredGenerationPort([
        FIXTURE_EXTRACTION,
        FIXTURE_EXTRACTION,
      ]);
      const chunk = makeChunk();

      await extractChunk(
        { structuredGeneration, rulebookStore },
        { rulebookSlug: slug, chunk, groups: GROUPS },
      );
      const withDifferentMenu = await extractChunk(
        { structuredGeneration, rulebookStore },
        {
          rulebookSlug: slug,
          chunk,
          groups: [...GROUPS, { slug: "general", when_to_use: "Anything else." }],
        },
      );

      expect(withDifferentMenu.cached).toBe(false);
      expect(structuredGeneration.calls).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("retries once on generation failure, then reports failed with no rules", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("extraction-retry-fail");
    try {
      const structuredGeneration = new AlwaysFailsPort();

      const result = await extractChunk(
        { structuredGeneration, rulebookStore },
        { rulebookSlug: slug, chunk: makeChunk(), groups: GROUPS },
      );

      expect(result.failed).toBe(true);
      expect(result.cached).toBe(false);
      expect(result.rules).toEqual([]);
      expect(result.usage).toEqual(ZERO_USAGE);
      // Initial attempt + exactly one retry, not more.
      expect(structuredGeneration.calls).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("usage flows through on a fresh call, is zero on a cache hit, and accumulates across chunks", async () => {
    const { root, rulebookStore, slug } = await makeRulebookStore("extraction-usage");
    try {
      const usageA: TokenUsage = {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      const usageB: TokenUsage = {
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 5,
        cacheWriteTokens: 0,
      };

      const first = await extractChunk(
        { structuredGeneration: new UsageReportingPort(FIXTURE_EXTRACTION, usageA), rulebookStore },
        { rulebookSlug: slug, chunk: makeChunk({ index: 0, contentHash: "1".repeat(64) }), groups: GROUPS },
      );
      const second = await extractChunk(
        { structuredGeneration: new UsageReportingPort(FIXTURE_EXTRACTION, usageB), rulebookStore },
        { rulebookSlug: slug, chunk: makeChunk({ index: 1, contentHash: "2".repeat(64) }), groups: GROUPS },
      );

      expect(first.usage).toEqual(usageA);
      expect(second.usage).toEqual(usageB);
      expect(addUsage(first.usage, second.usage)).toEqual({
        inputTokens: 150,
        outputTokens: 30,
        cacheReadTokens: 5,
        cacheWriteTokens: 0,
      });

      // Re-running the first chunk now hits the cache: zero usage, no new call.
      const cachedAgain = await extractChunk(
        { structuredGeneration: new UsageReportingPort(FIXTURE_EXTRACTION, usageA), rulebookStore },
        { rulebookSlug: slug, chunk: makeChunk({ index: 0, contentHash: "1".repeat(64) }), groups: GROUPS },
      );
      expect(cachedAgain.cached).toBe(true);
      expect(cachedAgain.usage).toEqual(ZERO_USAGE);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
