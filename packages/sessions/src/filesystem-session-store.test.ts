import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toVolumeSlug } from "@shadow/core";
import { InvalidSessionIdError, SessionEventsCorruptError } from "./errors.ts";
import { FileSystemSessionStore } from "./filesystem-session-store.ts";
import {
  runSessionStoreContractTests,
  type SessionStoreHarness,
} from "./session-store.contract.ts";
import type { SessionMeta } from "./session-store.ts";
import { expectRejection } from "./test-helpers.ts";

async function makeTempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "shadow-sessions-test-"));
}

async function makeHarness(): Promise<SessionStoreHarness> {
  const root = await makeTempRoot();
  return {
    store: new FileSystemSessionStore(root),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

// Runs the full implementation-agnostic suite against the filesystem backend.
runSessionStoreContractTests("FileSystemSessionStore", makeHarness);

function fixtureMeta(id: string): SessionMeta {
  return {
    id,
    volume: toVolumeSlug("demo-volume"),
    title: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("FileSystemSessionStore (filesystem-specific)", () => {
  test("defaults to ~/.shadow without touching disk at construction time", () => {
    expect(() => new FileSystemSessionStore()).not.toThrow();
  });

  test("on-disk layout matches <root>/sessions/<id>/{meta.json,events.jsonl}", async () => {
    const root = await makeTempRoot();
    try {
      const store = new FileSystemSessionStore(root);
      await store.create(fixtureMeta("layout-check"));
      await store.append("layout-check", [
        {
          turnId: "turn-1",
          at: "2026-01-01T00:00:01.000Z",
          event: { type: "operator-message", text: "hi" },
        },
      ]);

      const dir = join(root, "sessions", "layout-check");
      expect(await Bun.file(join(dir, "meta.json")).exists()).toBe(true);
      expect(await Bun.file(join(dir, "events.jsonl")).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("security boundary: a path-traversal id is rejected before it ever reaches the filesystem", async () => {
    const root = await makeTempRoot();
    try {
      const store = new FileSystemSessionStore(root);
      await expectRejection(store.get("../../etc/passwd"), InvalidSessionIdError);
      await expectRejection(store.create(fixtureMeta("../escape")), InvalidSessionIdError);
      await expectRejection(store.create(fixtureMeta("a/b")), InvalidSessionIdError);
      await expectRejection(store.create(fixtureMeta("abc\0def")), InvalidSessionIdError);

      // Confirm nothing escaped the root: the sessions dir is empty.
      expect(await store.list()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  describe("crash tolerance (torn tail vs. mid-file corruption)", () => {
    test("a torn LAST line is tolerated: readEvents returns the readable prefix, not a throw", async () => {
      const root = await makeTempRoot();
      try {
        const store = new FileSystemSessionStore(root);
        await store.create(fixtureMeta("torn-tail"));
        await store.append("torn-tail", [
          {
            turnId: "t1",
            at: "2026-01-01T00:00:01.000Z",
            event: { type: "operator-message", text: "one" },
          },
          {
            turnId: "t1",
            at: "2026-01-01T00:00:02.000Z",
            event: { type: "operator-message", text: "two" },
          },
        ]);

        const eventsPath = join(root, "sessions", "torn-tail", "events.jsonl");
        const wholeText = await Bun.file(eventsPath).text();
        // Simulate a process killed mid-`appendFile`/mid-write: chop the
        // last line off partway through, with no trailing newline.
        const tornText = wholeText.slice(0, -10);
        await Bun.write(eventsPath, tornText);

        const events = await store.readEvents("torn-tail");
        expect(events.map((e) => e.seq)).toEqual([1]);
        expect(events[0]?.event).toEqual({ type: "operator-message", text: "one" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("append after a torn tail heals it instead of gluing new bytes onto the torn line", async () => {
      const root = await makeTempRoot();
      try {
        const store = new FileSystemSessionStore(root);
        await store.create(fixtureMeta("self-heal"));
        await store.append("self-heal", [
          {
            turnId: "t1",
            at: "2026-01-01T00:00:01.000Z",
            event: { type: "operator-message", text: "one" },
          },
          {
            turnId: "t1",
            at: "2026-01-01T00:00:02.000Z",
            event: { type: "operator-message", text: "two" },
          },
        ]);

        const eventsPath = join(root, "sessions", "self-heal", "events.jsonl");
        const wholeText = await Bun.file(eventsPath).text();
        await Bun.write(eventsPath, wholeText.slice(0, -10));

        // The next append (as would happen when the server restarts and
        // the session resumes) must assign seq 2 to the new event — not
        // seq 3, which would silently re-lose the torn seq-2 record — and
        // must leave the file in a state later reads can parse cleanly.
        const stamped = await store.append("self-heal", [
          {
            turnId: "t2",
            at: "2026-01-01T00:00:03.000Z",
            event: { type: "operator-message", text: "three" },
          },
        ]);
        expect(stamped.map((r) => r.seq)).toEqual([2]);

        const events = await store.readEvents("self-heal");
        expect(events.map((e) => e.seq)).toEqual([1, 2]);
        expect(events[1]?.event).toEqual({ type: "operator-message", text: "three" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test("a corrupt line NOT last throws loudly instead of being silently dropped", async () => {
      const root = await makeTempRoot();
      try {
        const store = new FileSystemSessionStore(root);
        await store.create(fixtureMeta("mid-corrupt"));

        const eventsPath = join(root, "sessions", "mid-corrupt", "events.jsonl");
        const goodLine1 = JSON.stringify({
          seq: 1,
          turnId: "t1",
          at: "2026-01-01T00:00:01.000Z",
          event: { type: "operator-message", text: "one" },
        });
        const goodLine3 = JSON.stringify({
          seq: 3,
          turnId: "t1",
          at: "2026-01-01T00:00:03.000Z",
          event: { type: "operator-message", text: "three" },
        });
        // A hand-edited (or otherwise non-crash-caused) malformed line in
        // the middle, with a well-formed line after it — this can never
        // be a torn-append artifact, since nothing appends into the
        // middle of the file.
        await Bun.write(eventsPath, `${goodLine1}\nnot valid json at all\n${goodLine3}\n`);

        const rejection = await expectRejection(
          store.readEvents("mid-corrupt"),
          SessionEventsCorruptError,
        );
        expect(rejection.lineNumber).toBe(2);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
