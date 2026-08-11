import { describe, expect, test } from "bun:test";
import { createModel } from "@shadow/model";
import { AgenticSearchProvider } from "./agentic-search-provider.ts";

/**
 * Opt-in live proof that `AgenticSearchProvider` can drive Claude Code's
 * real `WebSearch` tool on the operator's subscription and come back with
 * strictly-parsed, non-empty results — the thing `bun test`'s offline suite
 * (`agentic-search-provider.test.ts`) cannot prove, because every session
 * there is a `FakeAgenticSessionPort`. Skipped by default so `bun test`
 * stays fast, offline, and deterministic. Run explicitly:
 *
 *   SHADOW_LIVE_TEST=1 bun test packages/research/src/live-smoke.test.ts
 *
 * Requires the `claude` CLI authenticated via subscription OAuth on this
 * machine (`claude login`), with `ANTHROPIC_API_KEY` unset.
 *
 * **Known environment issue**, same as `packages/model/src/live-smoke.test.ts`:
 * on at least one verified combination of Bun 1.3.14 and
 * `@anthropic-ai/claude-agent-sdk` 0.3.226, this throws synchronously from
 * inside the SDK's `setMaxListeners` (`The "eventTargets" argument must be
 * of type EventEmitter or EventTarget. Received an instance of
 * AbortSignal`) when run through `bun test`, but the identical call
 * sequence succeeds as a plain script run via `bun run`. If you hit this,
 * verify with a standalone `bun run` script instead of assuming a
 * regression — see `docs/DECISIONS.md` D6a.
 */
const RUN_LIVE = process.env.SHADOW_LIVE_TEST === "1";

describe.skipIf(!RUN_LIVE)("AgenticSearchProvider live smoke test (SHADOW_LIVE_TEST=1)", () => {
  test("a real WebSearch-backed search returns parsed, non-empty results", async () => {
    const model = createModel();
    const provider = new AgenticSearchProvider({ sessions: model.agenticSession });

    const response = await provider.search(
      { query: "Linear app design system sidebar", maxResults: 5 },
      async () => {
        throw new Error("AgenticSearchProvider must never call fetchImpl");
      },
    );

    expect(response.transport).toBe("live");
    expect(response.hits.length).toBeGreaterThan(0);
    for (const hit of response.hits) {
      expect(typeof hit.title).toBe("string");
      expect(hit.title.length).toBeGreaterThan(0);
      expect(() => new URL(hit.url)).not.toThrow();
    }

    // Session reuse (D6): a second query on the same provider instance
    // reuses the same session rather than paying the preamble again.
    const firstSessionId = provider.sessionId;
    expect(firstSessionId).toBeDefined();

    const second = await provider.search(
      { query: "Notion design system", maxResults: 3 },
      async () => {
        throw new Error("unused");
      },
    );
    expect(second.hits.length).toBeGreaterThan(0);
    expect(provider.sessionId).toBe(firstSessionId);
  }, 60_000);
});
