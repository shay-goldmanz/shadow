/**
 * Implementation-agnostic `SessionStore` test suite, mirroring
 * `@shadow/core`'s `volume-store.contract.ts`.
 *
 * Not a `*.test.ts` file itself — `bun test` won't pick it up on its own.
 * `filesystem-session-store.test.ts` and `in-memory-session-store.test.ts`
 * both import `runSessionStoreContractTests` and call it with a harness
 * factory, so every port method is verified against both implementations
 * from one source of truth.
 *
 * What's deliberately **not** here: the torn-tail/mid-corruption crash
 * tolerance the plan calls out (`SessionEventsCorruptError`'s doc). That
 * behavior is specific to `events.jsonl` being actual bytes on a real
 * filesystem — an in-memory `Map` has no "line" to truncate — so it lives
 * in `filesystem-session-store.test.ts`'s filesystem-specific block
 * instead, the same way `filesystem-volume-store.test.ts` keeps its
 * path-traversal "security boundary" test out of the shared
 * `VolumeStore` contract suite.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { toVolumeSlug } from "@shadow/core";
import { SessionAlreadyExistsError, SessionNotFoundError } from "./errors.ts";
import type { NewStoredEvent, SessionMeta, SessionStore } from "./session-store.ts";
import { expectRejection } from "./test-helpers.ts";

export interface SessionStoreHarness {
  store: SessionStore;
  cleanup(): Promise<void>;
}

function makeMeta(id: string, overrides: Partial<Omit<SessionMeta, "id">> = {}): SessionMeta {
  return {
    id,
    volume: toVolumeSlug("demo-volume"),
    title: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<NewStoredEvent> = {}): NewStoredEvent {
  return {
    turnId: "turn-1",
    at: "2026-01-01T00:00:01.000Z",
    event: { type: "operator-message", text: "hello" },
    ...overrides,
  };
}

export function runSessionStoreContractTests(
  implementationName: string,
  makeHarness: () => Promise<SessionStoreHarness>,
): void {
  describe(`SessionStore contract (${implementationName})`, () => {
    let harness: SessionStoreHarness;

    beforeEach(async () => {
      harness = await makeHarness();
    });

    afterEach(async () => {
      await harness.cleanup();
    });

    describe("create / get", () => {
      test("create/get round-trip", async () => {
        const { store } = harness;
        const meta = makeMeta("sess-1", { title: "First chat" });
        await store.create(meta);
        expect(await store.get("sess-1")).toEqual(meta);
      });

      test("create rejects a duplicate id", async () => {
        const { store } = harness;
        await store.create(makeMeta("dup"));
        await expectRejection(store.create(makeMeta("dup")), SessionAlreadyExistsError);
      });

      test("get returns undefined for a missing id, not an error", async () => {
        const { store } = harness;
        expect(await store.get("missing")).toBeUndefined();
      });

      test("sdkSessionId is absent until set", async () => {
        const { store } = harness;
        await store.create(makeMeta("no-sdk-yet"));
        const meta = await store.get("no-sdk-yet");
        expect(meta?.sdkSessionId).toBeUndefined();
      });
    });

    describe("list", () => {
      test("returns [] when empty", async () => {
        const { store } = harness;
        expect(await store.list()).toEqual([]);
      });

      test("newest first by lastActiveAt, ties broken by createdAt then id", async () => {
        const { store } = harness;
        await store.create(
          makeMeta("older-active", {
            lastActiveAt: "2026-01-01T00:00:00.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        );
        await store.create(
          makeMeta("newer-active", {
            lastActiveAt: "2026-01-03T00:00:00.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        );
        await store.create(
          makeMeta("tie-b", {
            lastActiveAt: "2026-01-02T00:00:00.000Z",
            createdAt: "2026-01-02T00:00:00.000Z",
          }),
        );
        await store.create(
          makeMeta("tie-a", {
            lastActiveAt: "2026-01-02T00:00:00.000Z",
            createdAt: "2026-01-02T00:00:00.000Z",
          }),
        );

        const listed = await store.list();
        expect(listed.map((m) => m.id)).toEqual(["newer-active", "tie-a", "tie-b", "older-active"]);
      });

      test("volume filter narrows to one volume; omitted filter lists every volume", async () => {
        const { store } = harness;
        const volA = toVolumeSlug("vol-a");
        const volB = toVolumeSlug("vol-b");
        await store.create(makeMeta("in-a", { volume: volA }));
        await store.create(makeMeta("in-b", { volume: volB }));

        expect((await store.list({ volume: volA })).map((m) => m.id)).toEqual(["in-a"]);
        expect((await store.list({ volume: volB })).map((m) => m.id)).toEqual(["in-b"]);
        expect((await store.list()).map((m) => m.id).toSorted()).toEqual(["in-a", "in-b"]);
      });
    });

    describe("update", () => {
      test("patches only the given fields, leaving the rest untouched", async () => {
        const { store } = harness;
        await store.create(makeMeta("patchable", { title: "Before" }));

        await store.update("patchable", { lastActiveAt: "2026-01-05T00:00:00.000Z" });

        const updated = await store.get("patchable");
        expect(updated?.title).toBe("Before");
        expect(updated?.lastActiveAt).toBe("2026-01-05T00:00:00.000Z");
      });

      test("title: omitted leaves it unchanged, explicit null clears it", async () => {
        const { store } = harness;
        await store.create(makeMeta("titled", { title: "Has a title" }));

        await store.update("titled", { lastActiveAt: "2026-01-05T00:00:00.000Z" });
        expect((await store.get("titled"))?.title).toBe("Has a title");

        await store.update("titled", { title: null });
        expect((await store.get("titled"))?.title).toBeNull();
      });

      test("sdkSessionId is set once and survives further unrelated patches", async () => {
        const { store } = harness;
        await store.create(makeMeta("gets-sdk-id"));

        await store.update("gets-sdk-id", { sdkSessionId: "sdk-abc" });
        expect((await store.get("gets-sdk-id"))?.sdkSessionId).toBe("sdk-abc");

        await store.update("gets-sdk-id", { lastActiveAt: "2026-01-06T00:00:00.000Z" });
        expect((await store.get("gets-sdk-id"))?.sdkSessionId).toBe("sdk-abc");
      });

      test("rejects a missing id", async () => {
        const { store } = harness;
        await expectRejection(store.update("missing", { title: "x" }), SessionNotFoundError);
      });
    });

    describe("append / readEvents", () => {
      test("append stamps seq starting at 1 and returns the stamped records", async () => {
        const { store } = harness;
        await store.create(makeMeta("evented"));

        const stamped = await store.append("evented", [
          makeEvent({ turnId: "turn-1" }),
          makeEvent({ turnId: "turn-1" }),
        ]);

        expect(stamped.map((r) => r.seq)).toEqual([1, 2]);
        expect(stamped.every((r) => r.turnId === "turn-1")).toBe(true);
      });

      test("seq is monotonic across separate append calls", async () => {
        const { store } = harness;
        await store.create(makeMeta("multi-append"));

        const first = await store.append("multi-append", [makeEvent()]);
        const second = await store.append("multi-append", [makeEvent(), makeEvent()]);

        expect(first.map((r) => r.seq)).toEqual([1]);
        expect(second.map((r) => r.seq)).toEqual([2, 3]);
      });

      test("readEvents on a freshly created session returns []", async () => {
        const { store } = harness;
        await store.create(makeMeta("no-events-yet"));
        expect(await store.readEvents("no-events-yet")).toEqual([]);
      });

      test("readEvents returns everything in seq order when fromSeq is omitted", async () => {
        const { store } = harness;
        await store.create(makeMeta("read-all"));
        await store.append("read-all", [makeEvent(), makeEvent(), makeEvent()]);

        const events = await store.readEvents("read-all");
        expect(events.map((r) => r.seq)).toEqual([1, 2, 3]);
      });

      test("readEvents(fromSeq) returns only seq >= fromSeq — the replay reconnect cursor", async () => {
        const { store } = harness;
        await store.create(makeMeta("from-seq"));
        await store.append("from-seq", [makeEvent(), makeEvent(), makeEvent(), makeEvent()]);

        const fromThree = await store.readEvents("from-seq", 3);
        expect(fromThree.map((r) => r.seq)).toEqual([3, 4]);

        const fromBeyondEnd = await store.readEvents("from-seq", 100);
        expect(fromBeyondEnd).toEqual([]);
      });

      test("event payload round-trips exactly, including a research event's stored briefId", async () => {
        const { store } = harness;
        await store.create(makeMeta("payload-roundtrip"));

        const [stamped] = await store.append("payload-roundtrip", [
          makeEvent({
            event: {
              type: "research-started",
              briefId: "turn-1/brief-0",
              brief: {
                volume: toVolumeSlug("demo-volume"),
                goal: "find out",
                subjectDomains: [],
                constraints: [],
                maxSources: 3,
              },
            },
          }),
        ]);

        expect(stamped?.event).toEqual({
          type: "research-started",
          briefId: "turn-1/brief-0",
          brief: {
            volume: toVolumeSlug("demo-volume"),
            goal: "find out",
            subjectDomains: [],
            constraints: [],
            maxSources: 3,
          },
        });
      });

      test("append rejects a missing id", async () => {
        const { store } = harness;
        await expectRejection(store.append("missing", [makeEvent()]), SessionNotFoundError);
      });

      test("readEvents rejects a missing id", async () => {
        const { store } = harness;
        await expectRejection(store.readEvents("missing"), SessionNotFoundError);
      });
    });

    describe("delete", () => {
      test("delete removes the session: get returns undefined afterward", async () => {
        const { store } = harness;
        await store.create(makeMeta("to-delete"));
        await store.append("to-delete", [makeEvent()]);

        await store.delete("to-delete");

        expect(await store.get("to-delete")).toBeUndefined();
      });

      test("a deleted session no longer appears in list", async () => {
        const { store } = harness;
        await store.create(makeMeta("listed-then-deleted"));
        await store.delete("listed-then-deleted");

        expect(await store.list()).toEqual([]);
      });

      test("delete rejects a missing id", async () => {
        const { store } = harness;
        await expectRejection(store.delete("missing"), SessionNotFoundError);
      });

      // Review #10: create-after-delete id reuse. The regression this guards
      // (F1 review fix): a filesystem implementation caching append state
      // per session id must invalidate that cache on delete, or a recreated
      // session at the same id would silently inherit the deleted session's
      // `lastSeq` instead of starting fresh at 1.
      test("create-after-delete: reusing a deleted id starts a genuinely fresh session, seq restarts at 1", async () => {
        const { store } = harness;
        await store.create(makeMeta("reused-id"));
        await store.append("reused-id", [makeEvent(), makeEvent(), makeEvent()]);
        await store.delete("reused-id");

        await store.create(makeMeta("reused-id", { title: "Second life" }));
        expect(await store.readEvents("reused-id")).toEqual([]);

        const stamped = await store.append("reused-id", [makeEvent()]);
        expect(stamped.map((r) => r.seq)).toEqual([1]);
        expect((await store.get("reused-id"))?.title).toBe("Second life");
      });
    });

    // Review #10: list order after `update` bumps `lastActiveAt`.
    describe("list order reflects update (review #10)", () => {
      test("updating lastActiveAt moves a session to the top of list()", async () => {
        const { store } = harness;
        await store.create(makeMeta("stays-put", { lastActiveAt: "2026-01-01T00:00:00.000Z" }));
        await store.create(makeMeta("gets-bumped", { lastActiveAt: "2026-01-01T00:00:00.000Z" }));

        expect((await store.list()).map((m) => m.id)).toEqual(["gets-bumped", "stays-put"]);

        await store.update("gets-bumped", { lastActiveAt: "2026-01-05T00:00:00.000Z" });

        expect((await store.list()).map((m) => m.id)).toEqual(["gets-bumped", "stays-put"]);

        await store.update("stays-put", { lastActiveAt: "2026-01-06T00:00:00.000Z" });

        expect((await store.list()).map((m) => m.id)).toEqual(["stays-put", "gets-bumped"]);
      });
    });
  });
}
