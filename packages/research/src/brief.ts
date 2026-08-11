/**
 * The research brief port (T2.1b).
 *
 * `docs/ARCHITECTURE.md`: *"Shadow never fetches: it delegates a research
 * brief and receives findings that are already bound to retrieved
 * sources."* This module is that contract. `@shadow/agent` (Shadow, T3.3)
 * depends on `ResearchBriefPort` only — never on `WebResearchToolAgent` or
 * any other concrete tool-agent (SOLID: dependency inversion at exactly the
 * seam `docs/ARCHITECTURE.md` draws between the two pillars).
 *
 * A `Finding` cannot exist without at least one `Citation`, and every
 * `Citation` names a `SourceId` that must resolve in the evidence ledger —
 * see `research-run.ts`'s `validateFindings`, which is what makes that true
 * structurally rather than by convention, mirroring D23's "witnessed, not
 * minted" for sources one level up, at the finding level.
 */

import type { VolumeSlug } from "@shadow/core";
import type { SourceId, SourceRecord } from "@shadow/evidence";

/**
 * What Shadow asks a tool-agent to go find out. Deliberately thin: a goal
 * in prose, which volume it will be a source for, and optional constraints
 * that are *guidance* to the tool-agent's own reasoning, not something this
 * package enforces mechanically (the model reads and follows them; nothing
 * here parses or validates their content).
 */
export interface ResearchBrief {
  /** Which volume any retrieved sources get recorded against. */
  readonly volume: VolumeSlug;
  /** What to find out, in prose — becomes the tool-agent's task. */
  readonly goal: string;
  /**
   * Hostnames that count as the *subject itself* for this brief (e.g.
   * `["linear.app"]` when researching how Linear designs its UI). Drives
   * the default `authority.tier` heuristic in `retrieval-tools.ts` — see
   * that module's doc for why this belongs on the brief and not on the
   * tool-agent's own judgment.
   */
  readonly subjectDomains?: readonly string[];
  /** Free-form guidance surfaced to the tool-agent's prompt (e.g. "prefer official documentation over blog commentary"). Not mechanically enforced. */
  readonly constraints?: readonly string[];
  /** Soft cap on distinct sources this brief may fetch. Enforced structurally — see `research-run.ts`'s `ResearchRun.recordFetch`. */
  readonly maxSources?: number;
}

/** One retrieved source a finding quotes from, with the exact span cited. */
export interface Citation {
  readonly sourceId: SourceId;
  /** Exact substring of the cited source's normalized snapshot text (`nfc-ws-v1`). Validated, not trusted — see `research-run.ts`. */
  readonly quote: string;
}

/** One thing the tool-agent found out, always bound to at least one real retrieval. */
export interface Finding {
  readonly text: string;
  readonly citations: readonly Citation[];
}

/** What a brief resolves to: findings, plus every source record they can cite (already written into the evidence ledger). */
export interface ResearchResult {
  readonly findings: readonly Finding[];
  readonly sources: readonly SourceRecord[];
}

/**
 * The port Shadow depends on. `research()` either returns findings whose
 * citations already resolve in the evidence ledger, or throws — there is no
 * third outcome where it returns a finding citing something never fetched.
 */
export interface ResearchBriefPort {
  research(brief: ResearchBrief): Promise<ResearchResult>;
}
