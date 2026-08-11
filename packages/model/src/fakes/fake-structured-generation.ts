/**
 * In-memory fake for `StructuredGenerationPort` — no LLM, no network.
 *
 * Exported from the package's public surface (`../index.ts`) so T2.x and
 * T3.x packages can test index/eval/judging logic against a scripted
 * response queue instead of a live model. Validates fixtures against the
 * caller's real Zod schema on every call — the same contract the real
 * adapter enforces — so a malformed test fixture fails the test with a
 * clear schema error instead of silently handing back the wrong shape.
 */

import { StructuredGenerationError } from "../errors.ts";
import type {
  StructuredGenerationPort,
  StructuredGenerationRequest,
  StructuredGenerationResult,
} from "../ports/structured-generation.ts";
import { ZERO_USAGE } from "../usage.ts";

export type FakeStructuredGenerationResponder = (
  request: StructuredGenerationRequest<unknown>,
) => unknown;

export class FakeStructuredGenerationPort implements StructuredGenerationPort {
  /** Every request this fake has received, in order — inspect in assertions. */
  readonly calls: Array<StructuredGenerationRequest<unknown>> = [];

  private readonly queue: unknown[];
  private readonly responder: FakeStructuredGenerationResponder | undefined;

  /**
   * @param fixtures Either a fixed queue of raw values (consumed in order,
   *   one per call — the object must satisfy each call's schema) or a
   *   function computing the raw value from the request each time.
   */
  constructor(fixtures: readonly unknown[] | FakeStructuredGenerationResponder = []) {
    if (typeof fixtures === "function") {
      this.responder = fixtures;
      this.queue = [];
    } else {
      this.queue = [...fixtures];
    }
  }

  async generate<Output>(
    request: StructuredGenerationRequest<Output>,
  ): Promise<StructuredGenerationResult<Output>> {
    this.calls.push(request);

    let raw: unknown;
    if (this.responder) {
      raw = await this.responder(request);
    } else {
      if (this.queue.length === 0) {
        throw new StructuredGenerationError(
          "FakeStructuredGenerationPort: no fixture queued for this call",
        );
      }
      raw = this.queue.shift();
    }

    const parsed = request.schema.safeParse(raw);
    if (!parsed.success) {
      throw new StructuredGenerationError(
        `FakeStructuredGenerationPort: fixture did not satisfy the request schema: ${parsed.error.message}`,
        parsed.error,
      );
    }

    return { object: parsed.data, usage: ZERO_USAGE };
  }
}
