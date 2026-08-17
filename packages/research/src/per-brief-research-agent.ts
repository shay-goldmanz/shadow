/**
 * `PerBriefResearchAgent` — the concurrency-safe `ResearchBriefPort` (T0.1).
 *
 * `docs/superpowers/specs/shadow-sessions/PLAN.md`'s Tier 0 root cause:
 * one `WebResearchToolAgent` shared by every conversation
 * (`packages/api/src/composition.ts`, pre-T0.1) reuses one `AgenticSession`
 * across every `research()` call on that instance (D6) and refuses a
 * second *concurrent* call outright (`busy` / `ResearchAgentBusyError`)
 * because its tool handlers close over instance-level `this.active` — a
 * second brief running on the shared instance at the same time would
 * corrupt which run a `fetch`/`submit_findings` call is scoped to. Sharing
 * one instance server-wide therefore serializes all research across every
 * conversation, not just within one.
 *
 * `PerBriefResearchAgent` removes the shared instance instead of trying to
 * make it safe: `research(brief)` constructs a brand-new
 * `WebResearchToolAgent` — same deps, fresh instance-level state — and
 * delegates to it. Every brief gets its own tool server closures, its own
 * `this.active`, its own `busy` flag that never sees a second call.
 * Concurrent briefs on different `research()` calls run on genuinely
 * separate agents; nothing is shared between them but the deps passed in
 * (a `RetrievalTransport`, an `EvidenceStore`, and an `AgenticSessionPort`
 * — see those modules'/T0.5's/T0.6's own concurrency-safety notes).
 *
 * A per-brief agent receives exactly one `research()` call, ever — one
 * `stream()`, one turn. `WebResearchToolAgent`'s session reuse (D6) exists
 * so a *second* `research()` call can resume the first call's session;
 * that rationale doesn't apply to an instance built to handle exactly one
 * call, so this factory sets `sessionTuning.persistSession: false` (see
 * that field's doc in `web-research-tool-agent.ts`). That has a second,
 * independent benefit: without it, every brief — even under the old
 * shared-instance design, on the second and later `research()` calls —
 * left behind one orphaned `~/.claude/projects/` transcript that nothing
 * ever closed or deleted; with it, a session that will never be resumed is
 * never written to disk in the first place.
 *
 * `ResearchAgentBusyError` stays defined and reachable in principle (a
 * caller could still construct and share a bare `WebResearchToolAgent`),
 * but this factory's own fresh-instance-per-call design means it can never
 * actually throw here.
 */

import type { ResearchBrief, ResearchBriefPort, ResearchResult } from "./brief.ts";
import { WebResearchToolAgent, type WebResearchToolAgentDeps } from "./web-research-tool-agent.ts";

/** Same shape `WebResearchToolAgent` itself takes — every field is forwarded verbatim to each fresh instance, `sessionTuning.persistSession` excepted (always forced `false`; see the module doc). */
export type PerBriefResearchAgentDeps = WebResearchToolAgentDeps;

/** The reference concurrency-safe `ResearchBriefPort` implementation — see the module doc. */
export class PerBriefResearchAgent implements ResearchBriefPort {
  constructor(private readonly deps: PerBriefResearchAgentDeps) {}

  research(brief: ResearchBrief): Promise<ResearchResult> {
    const agent = new WebResearchToolAgent({
      ...this.deps,
      sessionTuning: { ...this.deps.sessionTuning, persistSession: false },
    });
    return agent.research(brief);
  }
}
