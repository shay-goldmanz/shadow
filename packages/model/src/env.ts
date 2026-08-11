/**
 * Subprocess environment construction for the Agent SDK adapter.
 *
 * Verified fact: `Options.env` on `@anthropic-ai/claude-agent-sdk`'s
 * `query()` REPLACES the subprocess environment rather than merging with
 * it. Passing caller overrides directly as `env` silently drops `PATH` and
 * every other inherited variable, which breaks credential lookup — the
 * Claude CLI can no longer find its own OAuth keychain/config state and the
 * guardrail's job (prove subscription auth, not fall back past it) never
 * even gets exercised because the subprocess fails before producing an
 * `init` message worth checking.
 *
 * `buildSubprocessEnv` is the one place that spread happens, so a future
 * edit that "simplifies" `env: overrides` back out is a one-file regression
 * to catch, not a spread duplicated (and potentially dropped) at every call
 * site. Only used by the Port 2 adapter (`claude-agent-sdk-session.ts`),
 * which calls `query()` directly — `ai-sdk-provider-claude-code` (Port 1)
 * already builds its own sanitized-allowlist env internally and merges
 * caller overrides over that, so applying this a second time there would be
 * redundant, not protective.
 */
export function buildSubprocessEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  return { ...process.env, ...overrides };
}
