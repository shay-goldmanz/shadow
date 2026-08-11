import { describe, expect, test } from "bun:test";
import { FakeStructuredGenerationPort } from "@shadow/model";
import { ModelNavigationAgent } from "./lint-model-navigation-agent.ts";
import type { GradePayload, NavigatePayload, RoutePayload } from "./navigator.ts";

describe("ModelNavigationAgent", () => {
  test("route: derives consideredVolumeIds from the payload, chosenVolumeIds/why from the port", async () => {
    const payload: RoutePayload = {
      stage: "route",
      query: "how should I lay out a dense settings page?",
      skip: false,
      volumes: [
        { volume_id: "ui", title: "UI", chapter_count: 3 },
        { volume_id: "writing", title: "Writing", chapter_count: 2 },
      ],
    };
    const port = new FakeStructuredGenerationPort([
      { chosenVolumeIds: ["writing"], why: "it's a doc" },
    ]);
    const agent = new ModelNavigationAgent(port);

    const decision = await agent.route(payload);

    expect(decision.consideredVolumeIds).toEqual(["ui", "writing"]);
    expect(decision.chosenVolumeIds).toEqual(["writing"]);
    expect(decision.why).toBe("it's a doc");
  });

  test("navigate: passes chosen/rejected/reasoning through from the port", async () => {
    const payload: NavigatePayload = {
      stage: "navigate",
      query: "how should I lay out a dense settings page?",
      round: 1,
      chapters: [{ node_id: "C1", title: "Chapter One", tokens: 100 }],
      visited: [],
    };
    const port = new FakeStructuredGenerationPort([
      { chosen: ["C1"], rejected: [], reasoning: "matches directly" },
    ]);
    const agent = new ModelNavigationAgent(port);

    const decision = await agent.navigate(payload);

    expect(decision.chosen).toEqual(["C1"]);
    expect(decision.rejected).toEqual([]);
    expect(decision.reasoning).toBe("matches directly");
  });

  test("grade: need-more without a refinedQuery falls back to the original query", async () => {
    const payload: GradePayload = { query: "original task", round: 1, outline: "", passages: [] };
    const port = new FakeStructuredGenerationPort([{ verdict: "need-more" }]);
    const agent = new ModelNavigationAgent(port);

    const verdict = await agent.grade(payload);

    expect(verdict).toEqual({ kind: "need-more", refinedQuery: "original task" });
  });

  test("grade: sufficient and not-in-corpus pass through unchanged", async () => {
    const payload: GradePayload = { query: "task", round: 1, outline: "", passages: [] };
    const port = new FakeStructuredGenerationPort([
      { verdict: "sufficient" },
      { verdict: "not-in-corpus" },
    ]);
    const agent = new ModelNavigationAgent(port);

    expect(await agent.grade(payload)).toEqual({ kind: "sufficient" });
    expect(await agent.grade(payload)).toEqual({ kind: "not-in-corpus" });
  });

  // C-3 (Wave 2 review): RoutePayload/NavigatePayload carried no query
  // field, and route()/navigate() built prompts from the volume/chapter
  // rows alone — a model asked to "route a task" or "choose which chapters
  // answer a task" was never actually told what the task was. This is the
  // regression test for the gap: assert the task string is literally
  // present in the prompt text sent to the port, not just accepted as a
  // payload field that goes unused.
  test("route: the task reaches the model's prompt, not just the payload", async () => {
    const payload: RoutePayload = {
      stage: "route",
      query: "how should I lay out a dense settings page?",
      skip: false,
      volumes: [{ volume_id: "ui", title: "UI", chapter_count: 3 }],
    };
    const port = new FakeStructuredGenerationPort([{ chosenVolumeIds: ["ui"], why: "matches" }]);
    const agent = new ModelNavigationAgent(port);

    await agent.route(payload);

    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.prompt).toContain(payload.query);
  });

  test("navigate: the task reaches the model's prompt, not just the payload", async () => {
    const payload: NavigatePayload = {
      stage: "navigate",
      query: "how should I lay out a dense settings page?",
      round: 1,
      chapters: [{ node_id: "C1", title: "Chapter One", tokens: 100 }],
      visited: [],
    };
    const port = new FakeStructuredGenerationPort([{ chosen: ["C1"], rejected: [] }]);
    const agent = new ModelNavigationAgent(port);

    await agent.navigate(payload);

    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.prompt).toContain(payload.query);
  });
});
