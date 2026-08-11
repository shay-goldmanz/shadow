/**
 * `@shadow/cli` — the agent-facing contract (`docs/ARCHITECTURE.md`).
 *
 * Most consumers invoke the `shadow` binary (`bin.ts`) directly; this entry
 * exists for anything that wants to drive the same dispatch in-process
 * (e.g. a future test harness or the `shadow install` skill installer).
 */

export type { RunDeps } from "./cli.ts";
export { run } from "./cli.ts";
export { createContext, resolveShadowRoot } from "./context.ts";

export const PACKAGE_NAME = "@shadow/cli";
