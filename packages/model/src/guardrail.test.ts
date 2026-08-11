import { describe, expect, test } from "bun:test";
import { SubscriptionAuthError } from "./errors.ts";
import { assertSubscriptionAuth, SUBSCRIPTION_AUTH_SOURCE } from "./guardrail.ts";
import { expectSyncThrow } from "./test-helpers.ts";

describe("assertSubscriptionAuth", () => {
  test("passes when apiKeySource is 'none' (subscription auth)", () => {
    expect(() => assertSubscriptionAuth({ apiKeySource: "none" })).not.toThrow();
    expect(SUBSCRIPTION_AUTH_SOURCE).toBe("none");
  });

  test("passes and ignores subscriptionType when present", () => {
    expect(() =>
      assertSubscriptionAuth({ apiKeySource: "none", subscriptionType: "max" }),
    ).not.toThrow();
  });

  for (const apiKeySource of ["user", "project", "org", "temporary", "oauth"]) {
    test(`throws SubscriptionAuthError when apiKeySource is "${apiKeySource}"`, () => {
      const error = expectSyncThrow(
        () => assertSubscriptionAuth({ apiKeySource }),
        SubscriptionAuthError,
      );
      expect(error.apiKeySource).toBe(apiKeySource);
    });
  }

  test("the thrown error names the acceptance criterion", () => {
    const error = expectSyncThrow(
      () => assertSubscriptionAuth({ apiKeySource: "user" }),
      SubscriptionAuthError,
    );
    expect(error.message).toContain(
      "The entire stack runs on the operator's AI subscriptions, NOT on api keys",
    );
  });

  test("never reads ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN itself — it only trusts the caller-supplied AuthResolution", () => {
    // Deliberately mismatched with the environment: even if a real API key
    // were exported, this function must not go look for it — it must fail
    // solely on the resolved `apiKeySource` it was handed.
    const original = {
      key: process.env.ANTHROPIC_API_KEY,
      token: process.env.ANTHROPIC_AUTH_TOKEN,
    };
    process.env.ANTHROPIC_API_KEY = "sk-ant-definitely-not-a-real-key";
    process.env.ANTHROPIC_AUTH_TOKEN = "also-not-real";
    try {
      // Caller claims subscription auth ("none") — must pass regardless of
      // what's sitting in the environment, because the function never looks.
      expect(() => assertSubscriptionAuth({ apiKeySource: "none" })).not.toThrow();
    } finally {
      if (original.key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = original.key;
      if (original.token === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = original.token;
    }
  });
});
