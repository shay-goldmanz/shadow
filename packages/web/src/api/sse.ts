/**
 * Minimal `text/event-stream` reader. `EventSource` only supports `GET`, and
 * `docs/API.md`'s chat endpoint is a `POST`, so the stream has to be read by
 * hand off a `fetch` response body. Kept separate from `http-client.ts` so it
 * can be unit tested against a synthetic stream, without a network.
 */

export interface RawServerSentEvent {
  readonly event: string;
  readonly data: string;
}

/** Parses a `ReadableStream<Uint8Array>` of SSE bytes into named events, in arrival order. */
export async function* parseEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RawServerSentEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex !== -1) {
        const rawMessage = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const parsed = parseMessage(rawMessage);
        if (parsed) yield parsed;
        separatorIndex = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseMessage(raw: string): RawServerSentEvent | undefined {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join("\n") };
}
