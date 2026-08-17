/**
 * F2 — the HTTP chapter-publish handler (`PUT /api/volumes/:slug/chapters/:chapter`,
 * `handlers/chapters.ts`) shares `ShadowAgent`'s own `VolumeLocks` instance
 * with chat-driven publication (`ShadowConversation.runChapterDirective`,
 * T0.6), instead of bypassing locking entirely. Before this fix, the
 * handler called `evidenceStore.putClaims` + `publishChapter` directly,
 * racing a chat-driven publish on the same volume.
 *
 * ## Proof shape
 *
 * A gate-pattern probe, mirroring `research-concurrency.test.ts`'s
 * `ControllableResearchSessionPort` and `conversation.test.ts`'s T0.6 tests:
 * a `ControllableCheckWorthinessClassifier` shared by both paths (via
 * `WithApiOptions.checkWorthinessClassifier`, itself passed straight through
 * to `deps.checkWorthinessClassifier` — the same instance `publishChapter`
 * calls into on both the chat and HTTP paths) lets the test gate the very
 * moment a publish's own audit is in flight. A chat-driven `POST /api/chat`
 * publish is driven into that gate first — genuinely holding the volume
 * lock, not merely "probably running first" — and a concurrent HTTP `PUT`
 * publish on the *same* volume is then fired. If the lock instances were
 * different (the pre-fix bug), the HTTP path's own `classify()` call would
 * run immediately, in parallel with the gated chat call. With the fix, the
 * HTTP path's `classify()` call cannot even be *attempted* until the chat
 * publish's whole locked section — draft, audit, persist, reindex — has
 * released the lock.
 */

import { describe, expect, test } from "bun:test";
import { toVolumeSlug } from "@shadow/core";
import type {
  CheckWorthinessClassifier,
  CheckWorthinessInput,
  CheckWorthinessVerdict,
} from "@shadow/evidence";
import type { FakeAgenticTurnResponder } from "@shadow/model";
import { readAllSseEvents, seedVolume, withScriptedApi } from "../test-helpers.ts";

/**
 * Gates every `classify` call by index (0-based, in call order): the
 * `index`-th call does not resolve until the test calls `release(index)`.
 * `waitForCall` resolves once that call has genuinely started, independent
 * of which caller (chat vs. HTTP) made it — proof of "in flight," not
 * "about to be in flight."
 */
class ControllableCheckWorthinessClassifier implements CheckWorthinessClassifier {
  calls = 0;
  private readonly startResolvers: (() => void)[] = [];
  private readonly startPromises: Promise<void>[] = [];
  private readonly gateResolvers: (() => void)[] = [];

  async classify(
    inputs: readonly CheckWorthinessInput[],
  ): Promise<readonly CheckWorthinessVerdict[]> {
    const index = this.calls++;
    this.startPromises[index] = new Promise((resolve) => {
      this.startResolvers[index] = resolve;
    });
    this.startResolvers[index]?.();
    await new Promise<void>((resolve) => {
      this.gateResolvers[index] = resolve;
    });
    return inputs.map(() => ({
      checkRequired: false,
      rationale: "test fixture: gated classifier",
    }));
  }

  async waitForCall(index: number): Promise<void> {
    while (this.startPromises[index] === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await this.startPromises[index];
  }

  release(index: number): void {
    this.gateResolvers[index]?.();
  }
}

const CHAT_MARKER = "CHAT-PUBLISH-DIRECTIVE";
const CHAT_OPERATOR_TEXT = `${CHAT_MARKER}: the operator's belief about the chat chapter.`;

// Both chapter bodies below carry one sentence with no footnote marker at
// all, so the Tier 2 check-worthiness sweep (C1b) always has something to
// classify — that's what makes `ControllableCheckWorthinessClassifier.calls`
// increment exactly once per publish, chat or HTTP.
const UNMARKED_SENTENCE = "This sentence has no footnote at all, forcing a classify call.";

const respond: FakeAgenticTurnResponder = (prompt) => {
  if (!prompt.includes(CHAT_MARKER)) return { text: "Done." };
  const match = /Operator \(sourceId: (\S+)\):/.exec(prompt);
  const sourceId = match?.[1];
  if (!sourceId) throw new Error("operator sourceId missing from prompt");
  const chapter = {
    slug: "chat-published-chapter",
    title: "Chat-published chapter",
    body: [`This chapter is about the chat chapter.[^~belief]`, UNMARKED_SENTENCE].join(" "),
    claims: [
      {
        label: "belief",
        kind: "operator",
        text: "This chapter is about the chat chapter.",
        evidence: [{ sourceId, quote: CHAT_OPERATOR_TEXT }],
      },
    ],
  };
  return {
    text: ["Drafting.", "```shadow:chapter", JSON.stringify(chapter), "```"].join("\n"),
  };
};

describe("Chapters — HTTP publish shares ShadowAgent's volume lock with chat-driven publish (F2 review fix)", () => {
  test("a chat-directive publish holding the volume lock blocks a concurrent HTTP PUT publish on the same volume", async () => {
    const classifier = new ControllableCheckWorthinessClassifier();

    await withScriptedApi(
      { respond, checkWorthinessClassifier: classifier },
      async ({ baseUrl, deps }) => {
        const volume = toVolumeSlug("shared-volume");
        await seedVolume(deps, volume, "Shared Volume");

        const chatPromise = fetch(`${baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ volumeSlug: "shared-volume", message: CHAT_OPERATOR_TEXT }),
        });

        // Chat's own audit is now gated open (call index 0) -- it is
        // genuinely holding `deps.shadowAgent`'s volume lock for
        // "shared-volume", mid-`publishChapter`, not merely "started."
        await classifier.waitForCall(0);

        const putPromise = fetch(`${baseUrl}/api/volumes/shared-volume/chapters/put-chapter`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Put Chapter", body: UNMARKED_SENTENCE }),
        });

        // Give the PUT every real opportunity to reach its own `classify()`
        // call if it weren't actually locked out behind chat's publish --
        // this is a small, offline, in-process fake with nothing else to
        // wait on, so it would show up well within this window if it could
        // run at all.
        await Bun.sleep(50);
        expect(classifier.calls).toBe(1); // the PUT's own audit has not even started

        classifier.release(0); // let chat's publish (draft, audit, persist, reindex) finish and release the lock

        // The PUT's own `classify()` call (index 1) can only start once
        // chat's whole locked section has released -- proof this was
        // "queued, then ran," not "silently skipped" or "ran concurrently."
        await classifier.waitForCall(1);
        classifier.release(1);

        const [chatRes, putRes] = await Promise.all([chatPromise, putPromise]);

        expect(putRes.status).toBe(200);
        const putBody = (await putRes.json()) as {
          audit: { verdict: { passed: boolean }; published: boolean };
        };
        expect(putBody.audit.verdict.passed).toBe(true);
        expect(putBody.audit.published).toBe(true);

        const chatEvents = await readAllSseEvents(chatRes);
        expect(chatEvents.some((e) => e.event === "error")).toBe(false);
        expect(chatEvents.some((e) => e.event === "chapter.published")).toBe(true);
      },
    );
  });
});
