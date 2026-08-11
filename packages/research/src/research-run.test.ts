import { describe, expect, test } from "bun:test";
import { toSourceId } from "@shadow/evidence";
import { makeSource } from "@shadow/evidence/test-helpers";
import { SourceBudgetExceededError, UnboundCitationError } from "./errors.ts";
import type { FetchedSourceEntry } from "./research-run.ts";
import { ResearchRun, validateFindings } from "./research-run.ts";

function makeEntry(overrides: Partial<FetchedSourceEntry> = {}): FetchedSourceEntry {
  return {
    source: makeSource(),
    normalizedText: "Every measurement in the sidebar is a multiple of four.",
    ...overrides,
  };
}

describe("validateFindings", () => {
  test("accepts a finding whose citation resolves against a fetched source", () => {
    const entry = makeEntry();
    const fetched = new Map([[entry.source.id, entry]]);
    const findings = validateFindings(
      [
        {
          text: "Linear uses a 4px grid.",
          citations: [{ sourceId: entry.source.id, quote: "multiple of four" }],
        },
      ],
      fetched,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.citations[0]?.sourceId).toBe(entry.source.id);
  });

  test("normalizes the quote before matching, so incidental whitespace differences still resolve", () => {
    const entry = makeEntry({ normalizedText: "a multiple of four is used" });
    const fetched = new Map([[entry.source.id, entry]]);
    const findings = validateFindings(
      [{ text: "claim", citations: [{ sourceId: entry.source.id, quote: "multiple  of\nfour" }] }],
      fetched,
    );
    expect(findings).toHaveLength(1);
  });

  test("refuses a finding with zero citations", () => {
    expect(() =>
      validateFindings([{ text: "unsupported claim", citations: [] }], new Map()),
    ).toThrow(UnboundCitationError);
  });

  test("refuses a citation naming a sourceId that was never fetched in this run", () => {
    const unfetchedId = toSourceId(makeSource().id);
    try {
      validateFindings(
        [{ text: "claim", citations: [{ sourceId: unfetchedId, quote: "anything" }] }],
        new Map(),
      );
      expect.unreachable("expected UnboundCitationError");
    } catch (error) {
      expect(error).toBeInstanceOf(UnboundCitationError);
      expect((error as UnboundCitationError).sourceId).toBe(unfetchedId);
    }
  });

  test("refuses a quote that does not appear in the fetched source's text", () => {
    const entry = makeEntry({ normalizedText: "the real content of the page" });
    const fetched = new Map([[entry.source.id, entry]]);
    expect(() =>
      validateFindings(
        [
          {
            text: "claim",
            citations: [{ sourceId: entry.source.id, quote: "fabricated sentence" }],
          },
        ],
        fetched,
      ),
    ).toThrow(UnboundCitationError);
  });

  test("a batch with one bad citation rejects the whole batch, not just the bad finding", () => {
    const good = makeEntry({ normalizedText: "good source text" });
    const fetched = new Map([[good.source.id, good]]);
    const badId = toSourceId(makeSource().id);
    expect(() =>
      validateFindings(
        [
          { text: "good finding", citations: [{ sourceId: good.source.id, quote: "good source" }] },
          { text: "bad finding", citations: [{ sourceId: badId, quote: "anything" }] },
        ],
        fetched,
      ),
    ).toThrow(UnboundCitationError);
  });
});

describe("ResearchRun", () => {
  test("recordFetch grows sources; submit validates and accumulates findings", () => {
    const run = new ResearchRun();
    const entry = makeEntry();
    run.recordFetch(entry);
    expect(run.sources).toEqual([entry.source]);
    expect(run.getFetched(entry.source.id)).toEqual(entry);

    run.submit([
      { text: "a finding", citations: [{ sourceId: entry.source.id, quote: "multiple of four" }] },
    ]);
    expect(run.findingCount).toBe(1);
    expect(run.findingsSoFar[0]?.text).toBe("a finding");
  });

  test("submit throws and leaves findingsSoFar unchanged when a citation is unbound", () => {
    const run = new ResearchRun();
    expect(() =>
      run.submit([
        { text: "bad", citations: [{ sourceId: toSourceId(makeSource().id), quote: "x" }] },
      ]),
    ).toThrow(UnboundCitationError);
    expect(run.findingCount).toBe(0);
  });

  test("recordFetch enforces the source budget", () => {
    const run = new ResearchRun(1);
    run.recordFetch(makeEntry());
    expect(() => run.recordFetch(makeEntry())).toThrow(SourceBudgetExceededError);
    expect(run.fetchedCount).toBe(1);
  });

  test("no budget means no cap", () => {
    const run = new ResearchRun();
    for (let i = 0; i < 5; i++) run.recordFetch(makeEntry());
    expect(run.fetchedCount).toBe(5);
  });
});
