/**
 * The single place that turns a chosen mode into a concrete
 * `RetrievalTransport`. Callers depend on the `RetrievalTransport`
 * interface (`types.ts`); this factory is the only code that knows the
 * three concrete implementations exist.
 *
 * `mode` is a **required** field, not an optional one defaulting to
 * `"live"`. That is the safety mechanism this package uses to satisfy "no
 * environment sniffing, mode is injected, tests can't hit the network by
 * accident": there is no ambient default to fall into by omission, and
 * nothing in this file reads `NODE_ENV`, `CI`, or any other environment
 * variable to decide. A test suite that wants determinism constructs
 * `{ mode: "replay", fixturesRoot }` explicitly; there is no shorter path
 * that quietly means "live".
 */

import { FixtureCorpus } from "./fixture-corpus.ts";
import { LiveTransport, type LiveTransportOptions } from "./live-transport.ts";
import { RecordTransport } from "./record-transport.ts";
import { ReplayTransport } from "./replay-transport.ts";
import type { RetrievalTransport } from "./types.ts";

export type TransportMode = "live" | "record" | "replay";

export type CreateRetrievalTransportOptions =
  | { readonly mode: "live"; readonly live?: LiveTransportOptions }
  | {
      readonly mode: "record";
      readonly fixturesRoot: string;
      readonly live?: LiveTransportOptions;
    }
  | { readonly mode: "replay"; readonly fixturesRoot: string };

export function createRetrievalTransport(
  options: CreateRetrievalTransportOptions,
): RetrievalTransport {
  switch (options.mode) {
    case "live":
      return new LiveTransport(options.live);
    case "record":
      return new RecordTransport(
        new LiveTransport(options.live),
        new FixtureCorpus(options.fixturesRoot),
      );
    case "replay":
      return new ReplayTransport(new FixtureCorpus(options.fixturesRoot));
    default: {
      // Unreachable under the typed union; guards a caller that bypasses
      // TypeScript (plain JS, an `any` cast) from silently getting
      // `undefined` back instead of a `RetrievalTransport`.
      const exhaustive: never = options;
      throw new TypeError(`createRetrievalTransport: unknown mode ${JSON.stringify(exhaustive)}`);
    }
  }
}
