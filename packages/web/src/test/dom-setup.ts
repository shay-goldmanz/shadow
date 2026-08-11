/**
 * Ensures happy-dom's globals (`document`, `window`, ...) exist for component
 * tests.
 *
 * Normally the repo-root `bunfig.toml` preload (`test-preload.ts`) has already
 * registered them — it has to, because React 19 decides DOM support at module
 * evaluation time and a side-effect import here would run too late. This file
 * is the fallback for running this package's tests without that preload.
 *
 * The guard checks for an actual DOM rather than a private flag, so it stays
 * correct no matter who registered first — happy-dom throws if registered
 * twice, and two modules each tracking their own symbol would not see each
 * other.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof globalThis.document === "undefined") {
  GlobalRegistrator.register();
}
