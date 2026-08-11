import { describe, expect, test } from "bun:test";
import { buildSubprocessEnv } from "./env.ts";

describe("buildSubprocessEnv", () => {
  test("spreads process.env — a real inherited variable survives with no overrides", () => {
    // PATH is present in every process environment bun test runs under.
    const built = buildSubprocessEnv();
    expect(built.PATH).toBe(process.env.PATH);
    expect(built.PATH).toBeTruthy();
  });

  test("merges overrides over process.env without dropping the rest of it", () => {
    const built = buildSubprocessEnv({ CLAUDE_AGENT_SDK_CLIENT_APP: "shadow-model/test" });
    expect(built.PATH).toBe(process.env.PATH);
    expect(built.CLAUDE_AGENT_SDK_CLIENT_APP).toBe("shadow-model/test");
  });

  test("an override wins over an inherited value for the same key", () => {
    const built = buildSubprocessEnv({ PATH: "/deliberately/overridden" });
    expect(built.PATH).toBe("/deliberately/overridden");
  });

  test("this is a genuine spread, not a naive replace — this test would fail if a future edit collapsed it back to `env: overrides`", () => {
    // Regression guard for the exact D5 sharp edge: `options.env` on the
    // Agent SDK REPLACES the subprocess environment rather than merging.
    // If buildSubprocessEnv ever regressed to returning `overrides` as-is,
    // every process.env key other than the override would vanish — this
    // assertion is what catches that.
    const built = buildSubprocessEnv({ ONE_KEY: "value" });
    const keysFromProcessEnv = Object.keys(built).filter((key) => key !== "ONE_KEY");
    expect(keysFromProcessEnv.length).toBeGreaterThan(0);
    for (const key of keysFromProcessEnv) {
      expect(built[key]).toBe(process.env[key]);
    }
  });
});
