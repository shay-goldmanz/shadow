import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { FileSystemVolumeStore } from "@shadow/core";
import { createContext, resolveShadowRoot } from "./context.ts";

describe("resolveShadowRoot", () => {
  test("defaults to ~/.shadow when SHADOW_HOME is unset", () => {
    expect(resolveShadowRoot({})).toBe(join(homedir(), ".shadow"));
  });

  test("honors SHADOW_HOME when set, for test isolation", () => {
    expect(resolveShadowRoot({ SHADOW_HOME: "/tmp/some-root" })).toBe("/tmp/some-root");
  });

  test("ignores an empty-string SHADOW_HOME and falls back to the default", () => {
    expect(resolveShadowRoot({ SHADOW_HOME: "" })).toBe(join(homedir(), ".shadow"));
  });
});

describe("createContext", () => {
  test("builds a store rooted at the resolved root", () => {
    const ctx = createContext({ SHADOW_HOME: "/tmp/shadow-context-test-root" });
    expect(ctx.root).toBe("/tmp/shadow-context-test-root");
    expect(ctx.store).toBeInstanceOf(FileSystemVolumeStore);
  });

  test("accepts an explicit root override, ignoring env", () => {
    const ctx = createContext({ SHADOW_HOME: "/tmp/ignored" }, "/tmp/explicit-root");
    expect(ctx.root).toBe("/tmp/explicit-root");
  });
});
