import { useCallback, useRef, useState } from "react";
import type { ShadowApiClient } from "../api/client.ts";
import type { Route } from "../routing/useHashRoute.ts";
import { ChatInput } from "./ChatInput.tsx";
import { ChatTranscript } from "./ChatTranscript.tsx";
import {
  appendUserMessage,
  applyStreamEvent,
  beginStreaming,
  type ChatState,
  INITIAL_CHAT_STATE,
} from "./chat-transcript.ts";

/**
 * The centrepiece (docs/DECISIONS.md D1): the operator narrates beliefs and
 * watches Shadow work, streamed. Every event in `docs/API.md`'s SSE table
 * gets its own visible row via `ChatTranscript` — nothing is swallowed.
 */
export function ChatPage({
  client,
  slug,
  navigate,
}: {
  readonly client: ShadowApiClient;
  readonly slug: string;
  readonly navigate: (route: Route) => void;
}) {
  const [state, setState] = useState<ChatState>(INITIAL_CHAT_STATE);
  const sessionIdRef = useRef<string | undefined>(undefined);

  const send = useCallback(
    async (message: string) => {
      setState((prev) => beginStreaming(appendUserMessage(prev, message)));
      try {
        for await (const event of client.chat({
          volumeSlug: slug,
          message,
          sessionId: sessionIdRef.current,
        })) {
          if (event.event === "session") sessionIdRef.current = event.data.sessionId;
          setState((prev) => applyStreamEvent(prev, event));
        }
      } catch (err) {
        setState((prev) =>
          applyStreamEvent(prev, {
            event: "error",
            data: {
              message: err instanceof Error ? err.message : String(err),
              code: "stream_failed",
            },
          }),
        );
      }
    },
    [client, slug],
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

      <ChatTranscript items={state.items} />
      {state.streaming && (
        <p className="chat-page__status" aria-live="polite">
          Shadow is working
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
