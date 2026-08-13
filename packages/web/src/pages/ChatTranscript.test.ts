import { describe, expect, test } from "bun:test";
import { visibleAssistantText } from "./ChatTranscript.tsx";

describe("visibleAssistantText", () => {
  test("passes plain prose through unchanged", () => {
    expect(visibleAssistantText("Sure, I'll look into it.")).toBe("Sure, I'll look into it.");
  });

  test("strips a complete shadow:research block", () => {
    const text = 'Checking sources first. ```shadow:research\n{"goal": "..."}\n``` Back shortly.';
    expect(visibleAssistantText(text)).toBe("Checking sources first.  Back shortly.");
  });

  test("strips a complete shadow:chapter block, however long", () => {
    const text = `Writing it up now. \`\`\`shadow:chapter\n{"slug": "x", "body": "a very long escaped body..."}\n\`\`\``;
    expect(visibleAssistantText(text)).toBe("Writing it up now.");
  });

  test("buffers a still-streaming block instead of showing it raw", () => {
    // What the client actually receives mid-stream: the fence opened, but
    // its closing ``` hasn't arrived yet — this is the exact case that
    // rendered raw JSON for a few seconds and then vanished once the
    // block closed (the reported bug).
    const midStream =
      'Once the findings come back I\'ll load `writing-volumes` and draft the chapter.\n\n```shadow:research\n{"goal": "What is TanStack Query';
    expect(visibleAssistantText(midStream)).toBe(
      "Once the findings come back I'll load `writing-volumes` and draft the chapter.",
    );
  });

  test("buffers an in-progress second block after a first one already closed", () => {
    const midStream =
      'First finding is in. ```shadow:research\n{"goal": "a"}\n``` Now checking one more thing. ```shadow:chapter\n{"slug": "partial';
    expect(visibleAssistantText(midStream)).toBe(
      "First finding is in.  Now checking one more thing.",
    );
  });

  test("a single stray ``` with nothing after it is buffered, not shown", () => {
    expect(visibleAssistantText("About to write a block. ```")).toBe(
      "About to write a block.",
    );
  });
});
