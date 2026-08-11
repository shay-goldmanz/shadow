/**
 * The no-API-keys guardrail (D5).
 *
 * `ACCEPTANCE.md` is absolute: "The entire stack runs on the operator's AI
 * subscriptions, NOT on api keys." `@shadow/model` is the only package that
 * talks to an LLM, so it is the only place this can be enforced — and it is
 * enforced here, in one small, pure, independently-testable function.
 *
 * Both adapters resolve an `AuthResolution` from a signal the SDK itself
 * reports (the Agent SDK's `system`/`init` message's `apiKeySource` field,
 * verified on this machine to read `"none"` under subscription OAuth with
 * no API key set) and pass it to `assertSubscriptionAuth`. This function
 * never reads `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` itself — deciding
 * from the SDK's own resolved answer, not by re-deriving it from
 * environment variables, is what makes rule 2 below structurally true
 * rather than merely asserted:
 *
 *   1. Fail loudly the moment auth resolves to anything other than the
 *      subscription (never fall back, never proceed quietly).
 *   2. Never read `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in this
 *      package's own code.
 *   3. Be small, pure, and reusable enough to unit test without a live LLM.
 *
 * The `apiKeySource` field's declared type in `@anthropic-ai/claude-agent-sdk`
 * (`'user' | 'project' | 'org' | 'temporary' | 'oauth'`) does not actually
 * include the `"none"` literal it returns under subscription auth — a gap
 * between the shipped `.d.ts` and verified runtime behavior. `AuthResolution`
 * therefore types `apiKeySource` as `string`, not that narrower union: this
 * function must recognize `"none"` regardless of what the SDK's types claim
 * is possible, and widening here is what lets it.
 */

import { SubscriptionAuthError } from "./errors.ts";

/**
 * The literal value the Agent SDK reports when no API key is in play and
 * credentials resolved via subscription OAuth. Verified on this machine:
 * `claude` CLI 2.1.227, OAuth credentials in the macOS Keychain,
 * `ANTHROPIC_API_KEY` unset, subscription Claude Max.
 */
export const SUBSCRIPTION_AUTH_SOURCE = "none";

/**
 * What an adapter resolved about how the current call is authenticated,
 * sourced from the SDK's own report — never re-derived from environment
 * variables by this package.
 */
export interface AuthResolution {
  /**
   * The Agent SDK's `apiKeySource` value for this call. Subscription auth
   * reports `"none"` (see `SUBSCRIPTION_AUTH_SOURCE`); anything else means
   * some API key (user-set, project-set, org-set, a temporary credential,
   * or an OAuth *app* token distinct from `claude login`'s own account
   * OAuth) is in play.
   */
  readonly apiKeySource: string;
  /**
   * The Claude.ai subscription plan (`"pro"`, `"max"`, `"team"`,
   * `"enterprise"`), when the adapter fetched it via `accountInfo()` /
   * `SDKControlInitializeResponse.account`. Not required for the gate
   * itself — `apiKeySource` alone answers "API key or not?" — but useful
   * observability once the gate has passed.
   */
  readonly subscriptionType?: string;
}

/**
 * Fail loudly if `auth` did not resolve to the operator's subscription.
 *
 * @throws {SubscriptionAuthError} if `auth.apiKeySource` is anything other
 *   than `"none"`.
 */
export function assertSubscriptionAuth(auth: AuthResolution): void {
  if (auth.apiKeySource !== SUBSCRIPTION_AUTH_SOURCE) {
    throw new SubscriptionAuthError(auth.apiKeySource);
  }
}
