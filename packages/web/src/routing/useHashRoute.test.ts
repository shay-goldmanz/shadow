import { describe, expect, test } from "bun:test";
import { parseHash, routePath } from "./useHashRoute.ts";

describe("hash routing", () => {
  test("parses the volumes route from an empty or root hash", () => {
    expect(parseHash("")).toEqual({ name: "volumes" });
    expect(parseHash("#/")).toEqual({ name: "volumes" });
  });

  test("parses a volume route", () => {
    expect(parseHash("#/v/design-inspiration")).toEqual({
      name: "volume",
      slug: "design-inspiration",
    });
  });

  test("parses a chat route", () => {
    expect(parseHash("#/v/design-inspiration/chat")).toEqual({
      name: "chat",
      slug: "design-inspiration",
    });
  });

  test("parses a chapter route, decoding the slug", () => {
    expect(parseHash("#/v/design-inspiration/c/epoch-one-pagers")).toEqual({
      name: "chapter",
      slug: "design-inspiration",
      chapter: "epoch-one-pagers",
    });
  });

  test("parses a rulebooks list route", () => {
    expect(parseHash("#/r")).toEqual({ name: "rulebooks" });
  });

  test("parses a rulebook route", () => {
    expect(parseHash("#/r/loan-agreement-rules")).toEqual({
      name: "rulebook",
      slug: "loan-agreement-rules",
    });
  });

  test("parses a rulebook-group route, decoding the slug", () => {
    expect(parseHash("#/r/loan-agreement-rules/g/interest-and-fees")).toEqual({
      name: "rulebook-group",
      slug: "loan-agreement-rules",
      group: "interest-and-fees",
    });
  });

  test("routePath is the inverse of parseHash", () => {
    const routes = [
      { name: "volumes" as const },
      { name: "volume" as const, slug: "a b" },
      { name: "chat" as const, slug: "a b" },
      { name: "chapter" as const, slug: "a b", chapter: "c/d" },
      { name: "rulebooks" as const },
      { name: "rulebook" as const, slug: "a b" },
      { name: "rulebook-group" as const, slug: "a b", group: "c/d" },
    ];
    for (const route of routes) {
      expect(parseHash(routePath(route))).toEqual(route);
    }
  });
});
