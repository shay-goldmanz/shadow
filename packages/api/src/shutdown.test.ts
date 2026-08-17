/**
 * `shutdownGracefully` (F1 review fix) — proves the specific empirically-
 * confirmed bug directly: a real Bun server with an open streamed
 * `Response` (a stand-in for a T2.8 follow tab) never resolves an unforced
 * `server.stop()` promptly, and `shutdownGracefully` resolves quickly
 * anyway because it force-closes. The negative control exercises the exact
 * Bun behavior `start.ts:56` used to hit — an unforced `stop()` on an open
 * stream only resolves once the connection is reaped some other way (here,
 * a short `idleTimeout`; T2.8's real follow streams have none, so in
 * production this would simply never resolve).
 */

import { describe, expect, test } from "bun:test";
import { shutdownGracefully } from "./shutdown.ts";

/** A server with exactly one route: an SSE-shaped stream that never closes on its own — the open "fake SSE consumer" this test needs, mirroring a T2.8 follow tab held open by a connected client. */
function serveOpenStream(options: { readonly idleTimeout?: number } = {}) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: options.idleTimeout,
    fetch() {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
          // Deliberately never closes/enqueues again — an idle-but-open
          // follow stream (`session-events.ts`'s module doc: "turn end is
          // not a close condition") sits exactly like this between turns.
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    },
  });
}

describe("shutdownGracefully (F1)", () => {
  test("resolves promptly even with an open streamed response, because it force-closes", async () => {
    const server = serveOpenStream();
    try {
      const res = await fetch(server.url);
      const reader = res.body?.getReader();
      await reader?.read(); // consume the one enqueued chunk — proof the stream is genuinely open and connected, not idle-and-abandoned
      // Never released — this IS the "open fake SSE consumer" this fix's
      // own doc describes: nothing here ever calls `reader.cancel()` or
      // lets the connection go away on its own.

      const start = Date.now();
      let shutdownResolved = false;
      const shutdownPromise = shutdownGracefully({
        sessionService: { shutdown: async () => {} },
        server,
      }).then(() => {
        shutdownResolved = true;
      });

      // Bounded wait, not `await shutdownPromise` directly — a regression
      // back to the unforced `server.stop()` would hang this test forever
      // otherwise; the timeout race is what turns "hangs forever" into a
      // failing assertion instead of a stuck CI job.
      const timedOut = Symbol("timed out");
      const result = await Promise.race([
        shutdownPromise.then(() => "resolved" as const),
        new Promise((resolve) => setTimeout(() => resolve(timedOut), 3_000)),
      ]);

      expect(result).toBe("resolved");
      expect(shutdownResolved).toBe(true);
      // Resolved because it force-closed, not because something else (a
      // timeout, a reaped idle connection) eventually got there — well
      // under any such bound.
      expect(Date.now() - start).toBeLessThan(1_000);
    } finally {
      // Already stopped by `shutdownGracefully` above in the success case;
      // a defensive no-op otherwise (e.g. if the assertions above failed
      // first) — an already-stopped server tolerates a second `stop(true)`.
      await server.stop(true).catch(() => {});
    }
  });

  test("negative control: an UNFORCED server.stop() does not resolve promptly while the same stream is open", async () => {
    // A short `idleTimeout` (Bun requires an integer number of seconds) so
    // this test's own server eventually reaps itself and the test can
    // finish deterministically — T2.8's real follow streams carry no
    // `idleTimeout` at all, so in production the unforced call this
    // negative-controls against would simply never resolve, not just take
    // a few seconds.
    const server = serveOpenStream({ idleTimeout: 1 });
    try {
      const res = await fetch(server.url);
      const reader = res.body?.getReader();
      await reader?.read();

      const start = Date.now();
      await server.stop(); // unforced — the exact call `start.ts:56` used to make
      const elapsed = Date.now() - start;

      // Proves this exercised the real bug, not a scenario that happens to
      // pass either way: an unforced `stop()` on a still-open stream took
      // multiple seconds, bounded only by the connection eventually being
      // reaped some other way — not "closed right away," the way
      // `shutdownGracefully`'s force-closed call is above.
      expect(elapsed).toBeGreaterThan(500);
    } finally {
      await server.stop(true).catch(() => {});
    }
  }, 10_000);
});
