import { describe, expect, test } from "bun:test";
import { defaultChatScript } from "./fake-chat-script.ts";

describe("defaultChatScript (F7 review fix)", () => {
  test("operator is the first event after session and carries the sent message verbatim", () => {
    const events = defaultChatScript("sess_1", { message: "I believe in good design." });

    expect(events[0]).toEqual({ event: "session", data: { sessionId: "sess_1" } });
    expect(events[1]).toEqual({
      event: "operator",
      data: { text: "I believe in good design." },
    });
  });

  test('research briefIds use the real "<turnId>/brief-<n>" wire format, not a bare "brief-1"', () => {
    const events = defaultChatScript("sess_1", { message: "hi" });
    const briefIds = events
      .filter((e) => e.event === "research.started" || e.event === "research.finished")
      .map((e) => (e.data as { briefId: string }).briefId);

    expect(briefIds.length).toBeGreaterThan(0);
    for (const briefId of briefIds) {
      expect(briefId).toMatch(/^.+\/brief-\d+$/);
    }
    // Both research directives in the script share ONE turnId, matching the
    // real handler's per-HTTP-request (not per-directive) turnId minting.
    const turnIds = new Set(briefIds.map((id) => id.split("/brief-")[0]));
    expect(turnIds.size).toBe(1);
  });
});
