/**
 * A `NavigationAgent` (`navigator.ts`) backed by `@shadow/model`'s
 * `StructuredGenerationPort` — one structured-generation call per STAGE
 * (route/navigate/grade), each Zod-typed to exactly that stage's decision
 * shape.
 *
 * **Why this exists here, in `@shadow/indexing`, and not in the CLI.**
 * `NavigationAgent`'s own doc comment (`navigator.ts`) is explicit that
 * production (T3.1's CLI) does *not* implement it at all — each stage is a
 * separate process invocation driven by an external coding agent's own
 * reasoning, with no synchronous callback across that boundary.
 * `NavigationAgent` exists for **in-process** orchestration instead, and
 * lists exactly two example callers: a scripted test oracle, and "a real
 * model call through `@shadow/model`'s structured-generation port". Check
 * 2 (self-retrieval) is the second case — it needs to run `Navigator.find`
 * end-to-end, unattended, ~100 times per lint run, which is in-process
 * orchestration by definition. This class is that model call, reusing
 * `ReasoningNavigator` (T2.3) rather than reimplementing routing.
 *
 * Depends only on the `StructuredGenerationPort` **interface**
 * (`@shadow/model`'s public export), never an adapter — the default test
 * suite drives this class through `FakeStructuredGenerationPort`, and a
 * real `shadow lint` wiring (T3.1, out of scope here) would construct the
 * live adapter and hand it in unchanged.
 */

import type { StructuredGenerationPort } from "@shadow/model";
import { z } from "zod";
import type {
  GradePayload,
  NavigatePayload,
  NavigationAgent,
  RouteDecision,
  RoutePayload,
} from "./navigator.ts";
import type { NavigateDecision } from "./round-loop.ts";
import type { RetrievalVerdict } from "./trace.ts";

const routeSchema = z.object({
  chosenVolumeIds: z
    .array(z.string())
    .describe("volume_id values from the manifest most likely to contain the answer"),
  why: z.string().describe("one sentence explaining the choice"),
});

const navigateSchema = z.object({
  chosen: z.array(z.string()).describe("node_id values of the chapters that best answer the query"),
  rejected: z
    .array(z.object({ node_id: z.string(), why: z.string() }))
    .describe("chapters seriously considered and explicitly ruled out, with a reason each"),
  reasoning: z.string().optional(),
});

const gradeSchema = z.object({
  verdict: z.enum(["sufficient", "need-more", "not-in-corpus"]),
  refinedQuery: z
    .string()
    .optional()
    .describe("required when verdict is need-more: a refined version of the query"),
});

function formatVolumeManifest(payload: RoutePayload): string {
  return payload.volumes
    .map(
      (v) =>
        `- ${v.volume_id}: ${v.title} — when_to_use: ${v.when_to_use ?? "(none)"}; not_for: ${v.not_for ?? "(none)"}`,
    )
    .join("\n");
}

function formatChapterIndex(payload: NavigatePayload): string {
  return payload.chapters
    .map(
      (c) =>
        `- ${c.node_id}: ${c.title} — when_to_use: ${c.when_to_use ?? "(none)"}; not_for: ${c.not_for ?? "(none)"}`,
    )
    .join("\n");
}

/** Default `NavigationAgent`: one `StructuredGenerationPort.generate` call per stage. */
export class ModelNavigationAgent implements NavigationAgent {
  constructor(private readonly port: StructuredGenerationPort) {}

  async route(payload: RoutePayload): Promise<RouteDecision> {
    const { object } = await this.port.generate({
      schema: routeSchema,
      schemaName: "route_decision",
      system:
        "You are routing a task to the right volume(s) in a documentation corpus. Pick every volume that plausibly contains the answer.",
      prompt: `Task: ${payload.query ?? ""}\n\nVolumes:\n${formatVolumeManifest(payload)}`,
    });
    return {
      consideredVolumeIds: payload.volumes.map((v) => v.volume_id),
      chosenVolumeIds: object.chosenVolumeIds,
      why: object.why,
    };
  }

  async navigate(payload: NavigatePayload): Promise<NavigateDecision> {
    const { object } = await this.port.generate({
      schema: navigateSchema,
      schemaName: "navigate_decision",
      system:
        "You are choosing which chapters answer a task, from their when_to_use/not_for fields alone (never their body text). Choose the shallowest set that answers; reject anything close but ruled out by not_for.",
      prompt: `Task: ${payload.query ?? ""}\n\nRound ${payload.round}. Chapters:\n${formatChapterIndex(payload)}`,
    });
    return { chosen: object.chosen, rejected: object.rejected, reasoning: object.reasoning };
  }

  async grade(payload: GradePayload): Promise<RetrievalVerdict> {
    const { object } = await this.port.generate({
      schema: gradeSchema,
      schemaName: "grade_verdict",
      system:
        "You are grading whether the passages below fully answer the task. Respond not-in-corpus only if nothing relevant was found at all.",
      prompt: `Task: ${payload.query}\n\nOutline:\n${payload.outline}\n\nPassages:\n${payload.passages.map((p) => p.text).join("\n---\n")}`,
    });
    if (object.verdict === "need-more") {
      return { kind: "need-more", refinedQuery: object.refinedQuery ?? payload.query };
    }
    return { kind: object.verdict };
  }
}
