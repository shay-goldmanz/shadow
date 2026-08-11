/**
 * Registers happy-dom's globals (`document`, `window`, ...) for `bun test`.
 * Bun has no built-in DOM; every component test imports this file first
 * (side-effect import) so `bun test packages/web` runs fully offline with
 * no bunfig.toml preload needed at the repo root (out of scope for
 * `@shadow/web`, see the task's boundaries).
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";

const registered = Symbol.for("shadow.web.happy-dom-registered");

if (!(globalThis as Record<symbol, unknown>)[registered]) {
  GlobalRegistrator.register();
  (globalThis as Record<symbol, unknown>)[registered] = true;
}
