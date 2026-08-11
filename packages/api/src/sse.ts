/** Minimal Server-Sent Events framing — one function, no library. */

const encoder = new TextEncoder();

/** `event: <name>\ndata: <json>\n\n` — the wire format every SSE client (`EventSource`, or a manual `fetch` reader) expects. */
export function encodeSseEvent(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
