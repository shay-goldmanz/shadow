import { describe, expect, test } from "bun:test";
import type { AgenticSessionOptions } from "@shadow/model";
import { createModel, runToCompletion } from "@shadow/model";

/**
 * T0.4 — live-gated measurement of a per-brief research session's preamble
 * cost (`docs/superpowers/specs/shadow-sessions/PLAN.md`'s Tier 0 "honest
 * cost accounting" task, amending D6 — see that decision and T2.6).
 *
 * The design's original claim: per-brief agents (T0.1 — a fresh
 * `WebResearchToolAgent`/session per `research()` call, never resumed)
 * "skip re-paying the ~18k-token preamble" *if* Anthropic's server-side
 * prompt cache is warm across genuinely separate sessions with the same
 * system prompt/tool config. This test measures that directly rather than
 * assuming it: two fresh, non-persisted, research-shaped sessions (same
 * system prompt and session shape `PerBriefResearchAgent` actually opens
 * per brief — see `RESEARCH_SESSION_OPTIONS` below, mirroring
 * `web-research-tool-agent.ts`'s own `RESEARCH_SYSTEM_PROMPT`/session
 * options), a short gap apart, each reporting its own `TokenUsage`
 * (`@shadow/model`'s `cacheReadTokens` vs `cacheWriteTokens`). If the
 * second session's `cacheReadTokens` is near zero and `cacheWriteTokens` is
 * comparable to the first session's, that's the D6-contradicting outcome
 * the plan calls out: per-brief sessions do *not* skip the preamble tax
 * cross-session, they just avoid *compounding* it within one brief's single
 * turn (there was never a second turn to reuse cache on in the first
 * place). If `cacheReadTokens` on the second call is large instead, the
 * design's original hope holds. Either way this test only prints and
 * records the real numbers (`console.log`) and asserts sanity (usage
 * present, no thrown/isError turn) — never a threshold, because the number
 * itself is the finding T2.6 cites, not a pass/fail gate.
 *
 * **Caveat — "a short gap", not literally minutes.** The plan's task
 * description says "minutes after the first" to approximate a realistic
 * gap between two operator turns that each spawn their own brief. This
 * test does NOT sleep for minutes (that would make the offline-skipped
 * suite slow to even *start* under `SHADOW_LIVE_TEST=1`, and CI/dev-loop
 * patience is finite) — it sleeps a short, fixed delay instead
 * (`GAP_MS` below) and says so plainly in its own log output. Anthropic's
 * server-side prompt cache TTL is on the order of a few minutes, so this
 * measurement is a **lower bound** on cache staleness: if the cache is
 * already cold at `GAP_MS`, it would certainly also be cold minutes later;
 * if it is still warm at `GAP_MS`, that does not by itself prove it would
 * still be warm minutes later — an honest limitation, not a bug, and one
 * this file's own doc and the task report both say plainly rather than
 * letting the short delay pass as if it were the real measurement
 * condition.
 *
 * Skipped by default so `bun test` stays fast, offline, and deterministic
 * (same posture as this package's own `live-smoke.test.ts` and
 * `packages/model/src/live-smoke.test.ts`). Run explicitly:
 *
 *   SHADOW_LIVE_TEST=1 bun test packages/research/src/live-brief-cost-smoke.test.ts
 *
 * Requires the `claude` CLI authenticated via subscription OAuth on this
 * machine (`claude login`), with `ANTHROPIC_API_KEY` unset — see the two
 * `live-smoke.test.ts` files' docs for the known `bun test`-runner
 * incompatibility with at least one verified Bun/Agent-SDK combination
 * (falls back to a standalone `bun run` script if hit).
 *
 * **Second caveat — nested-session containers.** Verified while landing
 * T0.4 (standalone `bun run` script, working around the `bun test`
 * incompatibility above): run *from inside another Claude Code (Remote)
 * session*, both "fresh" sessions here came back reporting the **same**
 * `sessionId` — identical to the outer session's own `CLAUDE_CODE_SESSION_ID`
 * — even after this test's `RESEARCH_SESSION_OPTIONS`-equivalent explicitly
 * tried to strip that variable from the subprocess env. That container
 * appears to route nested `query()` calls through the same ambient
 * session/proxy rather than spawning two genuinely independent ones, which
 * would make `expect(session2.sessionId).not.toBe(session1.sessionId)`
 * below fail and any cache-read number it reports untrustworthy as
 * evidence of true cross-session caching. Run this on a real machine
 * (`claude login`'d directly, not inside a nested Claude Code session) for
 * a trustworthy number — see the task report this test shipped with for
 * the exact numbers obtained (and their caveat) in the sandboxed
 * environment it was authored in.
 */
const RUN_LIVE = process.env.SHADOW_LIVE_TEST === "1";

/** Not literally "minutes apart" — see this file's module doc caveat. */
const GAP_MS = 10_000;

/**
 * Mirrors `web-research-tool-agent.ts`'s own `RESEARCH_SYSTEM_PROMPT` and
 * session shape verbatim (custom system prompt string, no settings
 * sources loaded, `persistSession: false` since T0.1's per-brief sessions
 * are never resumed) — deliberately *not* imported from that module
 * (it's private to that file, by design — see its own class doc on
 * structural hardening) but kept in sync by hand here since this is only a
 * measurement fixture, not production wiring. No `toolServers`/
 * `allowedTools` are configured: this test only needs one plain turn to
 * measure the session-open preamble cost, not a real tool-calling research
 * run — findings/tool execution are exercised elsewhere
 * (`per-brief-research-agent.test.ts`, `web-research-tool-agent.test.ts`).
 */
const RESEARCH_SYSTEM_PROMPT =
  "You are a research tool-agent. Your only way to learn anything about the outside world is " +
  "the search/fetch tools provided — you have no other web access. Every finding you report " +
  "must be traceable to a page you actually fetched in this conversation, quoted exactly. " +
  "Never invent a sourceId, never invent a quote, and never report something you did not " +
  "actually read via `fetch`.";

const RESEARCH_SESSION_OPTIONS: AgenticSessionOptions = {
  systemPrompt: RESEARCH_SYSTEM_PROMPT,
  settingSources: [],
  disallowedTools: ["WebFetch", "WebSearch", "Bash"],
  persistSession: false,
};

describe.skipIf(!RUN_LIVE)(
  "Per-brief research session preamble cost (T0.4, SHADOW_LIVE_TEST=1)",
  () => {
    test("two fresh, non-persisted research-shaped sessions a short gap apart — cache read vs write recorded, not thresholded", async () => {
      const model = createModel();

      const session1 = model.agenticSession.createSession(RESEARCH_SESSION_OPTIONS);
      const result1 = await runToCompletion(session1, "Say 'ok' and nothing else.");

      console.log(
        `[T0.4] session 1 (first-ever, cold) usage: inputTokens=${result1.usage.inputTokens} ` +
          `outputTokens=${result1.usage.outputTokens} cacheReadTokens=${result1.usage.cacheReadTokens} ` +
          `cacheWriteTokens=${result1.usage.cacheWriteTokens}`,
      );

      console.log(`[T0.4] sleeping ${GAP_MS}ms (NOT minutes — see this file's module doc caveat)`);
      await Bun.sleep(GAP_MS);

      const session2 = model.agenticSession.createSession(RESEARCH_SESSION_OPTIONS);
      const result2 = await runToCompletion(session2, "Say 'ok' and nothing else.");

      console.log(
        `[T0.4] session 2 (fresh session, same shape, ${GAP_MS}ms later) usage: ` +
          `inputTokens=${result2.usage.inputTokens} outputTokens=${result2.usage.outputTokens} ` +
          `cacheReadTokens=${result2.usage.cacheReadTokens} cacheWriteTokens=${result2.usage.cacheWriteTokens}`,
      );

      console.log(
        "[T0.4] SUMMARY — per-brief preamble cost: " +
          `session1 cacheWrite=${result1.usage.cacheWriteTokens} cacheRead=${result1.usage.cacheReadTokens}; ` +
          `session2 cacheWrite=${result2.usage.cacheWriteTokens} cacheRead=${result2.usage.cacheReadTokens}. ` +
          (result2.usage.cacheReadTokens > result2.usage.cacheWriteTokens
            ? "Cross-session cache HIT observed (design's original hope holds at this gap)."
            : "Cross-session cache MISS/partial observed (D6-contradicting outcome the plan flags — " +
              "per-brief sessions re-pay the preamble on session 2)."),
      );

      // Sanity only, per T0.4's scope: the turn actually completed and
      // reported *some* usage. The real finding is the printed numbers
      // above (for T2.6 to cite), not a threshold here.
      expect(result1.isError).toBe(false);
      expect(result2.isError).toBe(false);
      expect(session1.sessionId).toBeDefined();
      expect(session2.sessionId).toBeDefined();
      // Fresh sessions never resumed one another.
      expect(session2.sessionId).not.toBe(session1.sessionId);
      expect(
        result1.usage.inputTokens + result1.usage.cacheReadTokens + result1.usage.cacheWriteTokens,
      ).toBeGreaterThan(0);
      expect(
        result2.usage.inputTokens + result2.usage.cacheReadTokens + result2.usage.cacheWriteTokens,
      ).toBeGreaterThan(0);
    }, 120_000);
  },
);
