/**
 * Independently-declared shapes for `shadow`'s JSON output — the contract
 * documented in `docs/INDEXING.md` ("The retrieval trace") and
 * `skills/shadow-find/SKILL.md`, not types imported from
 * `packages/cli/src/commands/*.ts`. A real coding agent parsing `shadow`'s
 * stdout has no access to this monorepo's TypeScript types either — it has
 * the JSON and the skill's prose description of it. Declaring the contract
 * here, separately, means a field this suite depends on that quietly
 * changed shape would show up as a real assertion failure against the
 * subprocess's actual output, not as a silent type-only drift caught by
 * sharing a type declaration with the code under test.
 */

export interface ChapterIndexRow {
  readonly node_id: string;
  readonly title: string;
  readonly when_to_use?: string;
  readonly not_for?: string;
  readonly keywords?: readonly string[];
  readonly tokens: number;
  readonly confidence?: string;
}

export interface NavigateResult {
  readonly stage: "navigate";
  readonly query: string;
  readonly round: number;
  readonly visited: readonly string[];
  readonly chapters: readonly ChapterIndexRow[];
  readonly next_steps: readonly string[];
}

export interface VerdictResult {
  readonly stage: "verdict";
  readonly query: string;
  readonly verdict: "not-in-corpus";
  readonly next_steps: readonly string[];
}

/** STAGE 0 (LOCATE) fallback hit (D11a) — a raw keyword/BM25 match, not a routed one. Per `skills/shadow-find/SKILL.md`: "Weak signal — do not trust it as-is." */
export interface PromotedResult {
  readonly stage: "promoted";
  readonly query: string;
  readonly node_id: string;
  readonly why: string;
  readonly next_steps: readonly string[];
}

export type FindResult = NavigateResult | VerdictResult | PromotedResult;

export interface ReadResult {
  readonly node_id: string;
  readonly body: string;
  readonly heading_path: readonly string[];
  readonly content_hash: string;
  readonly parent_when_to_use?: string;
  readonly sibling_titles?: readonly string[];
  readonly next_steps: readonly string[];
}

export interface InstallResult {
  readonly skill: string;
  readonly written: string;
  readonly target: string;
  readonly next_steps: readonly string[];
}

export interface IndexBuildResult {
  readonly stats: { readonly volumes: number; readonly chapters: number; readonly tokens: number };
  readonly corpus_hash: string;
  readonly next_steps: readonly string[];
}

export interface ErrorEnvelope {
  readonly error: { readonly name: string; readonly message: string };
  readonly next_steps: readonly string[];
}

/** An entry from `shadow misses` (D14, T2.7) — the shared `FileMissLog` `shadow find`'s not-in-corpus verdicts and `shadow lint`'s self-retrieval failures both write to. */
export interface LoggedMiss {
  readonly task: string;
  readonly recordedAt: string;
  readonly source?: "find" | "lint";
  readonly reason?: "no-match" | "empty-corpus" | "rounds-exhausted";
  readonly round?: number;
}

export interface MissesResult {
  readonly misses: readonly LoggedMiss[];
  readonly count: number;
  readonly next_steps: readonly string[];
}

/** `sha256:<64 hex chars>` — the citation anchor format documented in `docs/INDEXING.md`. */
export const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
