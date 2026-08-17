/**
 * The graceful-shutdown sequence `start.ts`'s SIGINT/SIGTERM handler runs —
 * pulled out into its own module (F1 review fix) so it's testable without
 * importing `start.ts` itself, which builds a real `ApiDeps` and binds a
 * real server as side effects of module evaluation (`start.ts`'s own doc).
 *
 * ## Why `server.stop()` needs the force flag
 *
 * Bun's `server.stop()`, called without `closeActiveConnections = true`,
 * does not resolve while any streamed `Response` is still open — and T2.8
 * holds exactly that kind of connection open for every mounted session tab
 * (`GET /api/sessions/:id/events?follow=true` never sends `done` on its own;
 * `handlers/session-events.ts`'s module doc, "turn end is not a close
 * condition"). Before this fix, `start.ts` called the unforced `server.stop()`
 * — harmless the moment nothing was streaming, but the instant one follow
 * tab was open, Ctrl-C simply never completed: `shutdown()` would await a
 * `server.stop()` promise that could only resolve once every open stream
 * closed itself, which none of them do voluntarily. The operator's only way
 * out was `kill -9`, undoing T2.9's entire point (a real graceful wind-down
 * instead of a hard kill).
 *
 * ## Ordering: wind down first, THEN force-close
 *
 * `sessionService.shutdown()` runs to completion (or its own ~10s deadline)
 * *before* `server.stop(true)` is ever called — the graceful sequence
 * (signal running turns, append `turn-boundary(ended, interrupted)`, flush
 * appends, release handles) needs every in-flight turn to actually finish
 * winding down cleanly, which has nothing to do with any open SSE stream.
 * Only once that has settled does anything here reach for the force flag —
 * at that point, every connection still open is an idle-but-open VIEWER
 * stream (a follow tab with nothing left to watch), exactly what force-close
 * exists for: it does not tear anything mid-write, because nothing is
 * mid-write any more.
 */

export interface ShutdownDeps {
  readonly sessionService: { shutdown(): Promise<void> };
  readonly server: { stop(closeActiveConnections?: boolean): Promise<void> };
}

/** Runs the sequence above once. Idempotent to the extent `sessionService.shutdown()` and `server.stop()` themselves are (both are — see their own docs); `start.ts`'s own `shuttingDownStarted` guard is what actually prevents calling this twice in the real process. */
export async function shutdownGracefully(deps: ShutdownDeps): Promise<void> {
  await deps.sessionService.shutdown();
  await deps.server.stop(true);
}
