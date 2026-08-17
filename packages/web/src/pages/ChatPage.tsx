import { useCallback, useEffect, useRef, useState } from "react";
import type { ShadowApiClient } from "../api/client.ts";
import type { ChatStreamEvent } from "../api/types.ts";
import type { NavigateOptions, Route } from "../routing/useHashRoute.ts";
import { ChatInput } from "./ChatInput.tsx";
import { ChatTranscript } from "./ChatTranscript.tsx";
import {
  applyStreamEvent,
  beginStreaming,
  type ChatState,
  INITIAL_CHAT_STATE,
  markInterruptedIfPending,
} from "./chat-transcript.ts";

/**
 * The centrepiece (docs/DECISIONS.md D1): the operator narrates beliefs and
 * watches Shadow work, streamed. Every event in `docs/API.md`'s SSE table
 * gets its own visible row via `ChatTranscript` — nothing is swallowed.
 *
 * ## URL identity + replay (T2.8)
 *
 * `sessionId` present (mounted at `#/v/:slug/chat/:sessionId` — a reload, a
 * second tab, or a session-list "resume") makes THIS the driver: a
 * `getSessionEvents(id, { follow: true })` subscription (below) replays the
 * stored transcript and stays open, feeding every event through
 * `applyStreamEvent` for the component's whole lifetime — including turns
 * THIS tab itself later sends, so its own `send()` does not ALSO apply
 * those events (that would render every message twice; see `following`
 * below). This is also how a passive second tab sees another tab's queued
 * turns "just appear," with no separate plumbing (PLAN.md's Tier 2 intro).
 *
 * `sessionId` absent (`#/v/:slug/chat`, a brand-new chat) means `send()`
 * drives its own `POST /api/chat` stream directly instead, exactly as
 * before T2.8 — no follow subscription exists yet to duplicate against.
 * Once the first send's `session` event mints an id, `navigate` swaps the
 * URL to the id-carrying form (`replace: true` — the id-less form only ever
 * existed for the instant before the first message, so back should skip
 * over it) — but this component keeps driving its OWN content directly for
 * the rest of its life; it does not retroactively open a follow
 * subscription mid-conversation (which would mean discarding and
 * re-replaying already-rendered state, racing the very rendering it would
 * be trying to keep stable). The next full mount at that URL (a reload)
 * gets the follow treatment from the start.
 *
 * `streaming` (disables `ChatInput`) is always driven by THIS tab's own
 * `send()` call lifecycle, regardless of `following` — "unchanged
 * convention": true the instant `send()` starts, false once its own
 * request settles. Transcript CONTENT is what `following` gates.
 */
export function ChatPage({
  client,
  slug,
  sessionId,
  navigate,
}: {
  readonly client: ShadowApiClient;
  readonly slug: string;
  /** The session this mount opened at, if any (`Route`'s `chat.sessionId`). Only its value AT MOUNT matters — see this component's doc for why a later id (minted by this tab's own first send) does not retroactively switch modes. */
  readonly sessionId?: string;
  readonly navigate: (route: Route, options?: NavigateOptions) => void;
}) {
  const [state, setState] = useState<ChatState>(INITIAL_CHAT_STATE);
  const sessionIdRef = useRef<string | undefined>(sessionId);
  // Captured once, at mount — see this component's doc.
  const followingRef = useRef(sessionId !== undefined);

  // Replay + follow (T2.7/T2.8): the sole content source for a mount that
  // already knows its session id. Runs for the component's whole lifetime;
  // cancelled on unmount (the `for await` below is left via the cleanup's
  // `cancelled` flag, which `for await...of`'s implicit `.return()` then
  // unsubscribes on, same as any other early exit of that loop).
  useEffect(() => {
    if (!followingRef.current) return;
    const id = sessionIdRef.current;
    if (id === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        for await (const evt of client.getSessionEvents(id, { follow: true })) {
          if (cancelled) return;
          setState((prev) =>
            applyStreamEvent(prev, { event: evt.event, data: evt.data } as ChatStreamEvent),
          );
        }
      } catch {
        // Connection dropped — nothing more this tab can do about it; a
        // fresh mount (reload) picks the transcript back up via a fresh
        // replay. Fall through to the same "did this leave a turn hanging"
        // check a clean stream end gets, below.
      }
      if (!cancelled) {
        // T2.1's torn-tail shape: the stream ended (cleanly or not) with no
        // terminal signal for whatever turn was open — nothing else will
        // ever announce it (`markInterruptedIfPending`'s doc). A no-op
        // whenever the transcript isn't actually mid-turn.
        setState((prev) => markInterruptedIfPending(prev));
      }
    })();
    return () => {
      cancelled = true;
    };
    // Mount-only by design (`followingRef`/`sessionIdRef` are refs
    // specifically so this effect never needs to re-run on a later
    // `sessionId` — see this component's doc).
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally mount-only, see comment above
  }, [client]);

  const send = useCallback(
    async (message: string) => {
      setState((prev) => beginStreaming(prev));
      // Content is applied directly only when nothing else (the follow
      // subscription above) is already going to deliver it — see this
      // component's doc.
      const applyLocally = !followingRef.current;
      try {
        for await (const event of client.chat({
          volumeSlug: slug,
          message,
          sessionId: sessionIdRef.current,
        })) {
          if (event.event === "session") {
            const isNewSession = sessionIdRef.current === undefined;
            sessionIdRef.current = event.data.sessionId;
            if (isNewSession) {
              navigate({ name: "chat", slug, sessionId: event.data.sessionId }, { replace: true });
            }
          }
          if (applyLocally) {
            setState((prev) => applyStreamEvent(prev, event));
          }
        }
      } catch (err) {
        // A pure client/network fault (the request never reached the
        // server, or its stream broke mid-flight) — the follow subscription
        // can never learn of this on its own (nothing was recorded), so
        // it's surfaced locally regardless of `applyLocally`.
        setState((prev) =>
          applyStreamEvent(prev, {
            event: "error",
            data: {
              message: err instanceof Error ? err.message : String(err),
              code: "stream_failed",
            },
          }),
        );
      } finally {
        // `streaming` is always locally owned (this component's doc).
        // `markInterruptedIfPending` only runs when THIS loop itself was
        // the one applying content (`applyLocally`) — when it isn't, the
        // follow subscription above owns `turnPending` for this turn, quite
        // possibly not yet caught up to this loop's own end (an
        // independent connection to the same turn): calling it here
        // regardless would risk marking a turn "interrupted" that follow is
        // simply about to finish reporting normally, a moment later.
        setState((prev) => ({
          ...(applyLocally ? markInterruptedIfPending(prev) : prev),
          streaming: false,
        }));
      }
    },
    [client, slug, navigate],
  );

  return (
    <div className="page chat-page">
      <header className="page__header">
        <button
          type="button"
          className="link-back"
          onClick={() => navigate({ name: "volume", slug })}
        >
          ← {slug}
        </button>
        <h1>Chat with Shadow</h1>
      </header>

      <ChatTranscript items={state.items} onRetry={(text) => void send(text)} />
      {state.streaming && (
        <p className="chat-page__status" aria-live="polite">
          Shadowing
          <span className="typing-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </p>
      )}
      <ChatInput onSend={(message) => void send(message)} disabled={state.streaming} />
    </div>
  );
}
