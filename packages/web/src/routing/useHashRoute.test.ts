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

  // T2.8: the session's own address — mounting it replays the stored
  // transcript and follows it live.
  test("parses a chat route with a session id, decoding it", () => {
    expect(parseHash("#/v/design-inspiration/chat/sess_123")).toEqual({
      name: "chat",
      slug: "design-inspiration",
      sessionId: "sess_123",
    });
    expect(parseHash("#/v/design-inspiration/chat/sess%20with%20space")).toEqual({
      name: "chat",
      slug: "design-inspiration",
      sessionId: "sess with space",
    });
  });

  test("parses a chapter route, decoding the slug", () => {
    expect(parseHash("#/v/design-inspiration/c/epoch-one-pagers")).toEqual({
      name: "chapter",
      slug: "design-inspiration",
      chapter: "epoch-one-pagers",
    });
  });

  test("routePath is the inverse of parseHash", () => {
    const routes = [
      { name: "volumes" as const },
      { name: "volume" as const, slug: "a b" },
      { name: "chat" as const, slug: "a b" },
      { name: "chat" as const, slug: "a b", sessionId: "sess a/b" },
      { name: "chapter" as const, slug: "a b", chapter: "c/d" },
    ];
    for (const route of routes) {
      expect(parseHash(routePath(route))).toEqual(route);
    }
  });
});
