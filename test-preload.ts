/**
 * Root `bun test` preload.
 *
 * `@shadow/web`'s component tests need DOM globals, and they must exist
 * *before* React evaluates: React 19 decides DOM support once at module
 * evaluation time, and Bun's CJS interop hoists `react-dom` ahead of a
 * same-file side-effect import. So registration has to happen in a preload,
 * and the preload has to be at the repo root because CI runs `bun test` from
 * here (a package-scoped `bunfig.toml` only applies under `--cwd`).
 *
 * But happy-dom also replaces the global `fetch`/`Response`/`Request`/
 * `Headers` with its own browser-shaped implementations, and those cannot
 * talk to a real local HTTP server — `@shadow/api`'s tests, which start a
 * `Bun.serve` instance and call it over the loopback interface, fail with
 * "Parse Error" against happy-dom's client.
 *
 * happy-dom also replaces `ReadableStream`/`WritableStream`/`TransformStream`
 * (`BrowserWindow.ts` wires `ReadableStream` to Node's `stream/web` version,
 * and — more surprisingly — `WritableStream`/`TransformStream` to Node's
 * *classic* `Stream.Writable`/`Stream.Transform`, which aren't WHATWG stream
 * classes at all). Bun's native fetch/undici stack does `instanceof
 * ReadableStream` against its own class when consuming a streamed response
 * body, so once happy-dom's globals are in place that check fails against a
 * genuinely-native stream. Any `streamText`-based code (e.g. the Bedrock
 * agentic-session port) then throws `TypeError: readable should be
 * ReadableStream` within milliseconds, before any network call happens —
 * only under `bun test`, since the preload never runs under plain `bun run`.
 * (Found live in Bedrock smoke-test verification.)
 *
 * Nothing in the codebase wants happy-dom's network stack: the web tests
 * drive a fake API client and never touch `fetch`, while every package that
 * does real I/O wants Bun's native implementation. So we take the DOM and
 * put the network back.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";

const registered = Symbol.for("shadow.test.happy-dom-registered");

if (!(globalThis as Record<symbol, unknown>)[registered]) {
  // Capture Bun's native network globals before happy-dom overwrites them.
  const nativeFetch = globalThis.fetch;
  const nativeResponse = globalThis.Response;
  const nativeRequest = globalThis.Request;
  const nativeHeaders = globalThis.Headers;
  const nativeReadableStream = globalThis.ReadableStream;
  const nativeWritableStream = globalThis.WritableStream;
  const nativeTransformStream = globalThis.TransformStream;

  GlobalRegistrator.register();

  globalThis.fetch = nativeFetch;
  globalThis.Response = nativeResponse;
  globalThis.Request = nativeRequest;
  globalThis.Headers = nativeHeaders;
  globalThis.ReadableStream = nativeReadableStream;
  globalThis.WritableStream = nativeWritableStream;
  globalThis.TransformStream = nativeTransformStream;

  (globalThis as Record<symbol, unknown>)[registered] = true;
}
