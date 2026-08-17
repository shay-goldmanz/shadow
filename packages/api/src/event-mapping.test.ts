/**
 * T2.2's test surface: golden ShadowEvent -> wire mapping tables,
 * `StoredEventStamper` brief-id correlation/uniqueness, and — the point of
 * moving this into a shared module at all — proof that the live path and a
 * stored+replayed path produce the identical wire transcript for the same
 * turn.
 */

import { describe, expect, test } from "bun:test";
import type { ShadowEvent } from "@shadow/agent";
import { toChapterSlug, toVolumeSlug } from "@shadow/core";
import type { CheckIssue, RepairDecision } from "@shadow/evidence";
import { fixtureClaimId, makeSource } from "@shadow/evidence/test-helpers";
import type { ResearchBrief, ResearchResult } from "@shadow/research";
import type { StoredSessionEvent } from "@shadow/sessions";
import {
  operatorMessageEvent,
  type StampableAgentEvent,
  StoredEventStamper,
  turnBoundaryEnded,
  turnBoundaryStarted,
  type WireEvent,
  wireEventsForLive,
  wireEventsFromStored,
} from "./event-mapping.ts";

const volume = toVolumeSlug("design-craft");
const chapter = toChapterSlug("spacing");

function brief(goal: string): ResearchBrief {
  return { volume, goal };
}

/** `list.find(predicate)?.data as T`, but throws instead of risking an unsafe optional-chain property read when nothing matches — mirrors `chat.test.ts`'s own "must be present" assertions. */
function dataOfFirst<T>(list: readonly WireEvent[], event: string): T {
  const found = list.find((w) => w.event === event);
  if (!found) throw new Error(`expected a "${event}" wire event`);
  return found.data as T;
}

describe("wireEventsFromStored — golden mapping table", () => {
  test("operator-message -> operator", () => {
    expect(wireEventsFromStored(operatorMessageEvent("Hi Shadow!"))).toEqual([
      { event: "operator", data: { text: "Hi Shadow!" } },
    ]);
  });

  test("operator-turn-recorded -> dropped (no doc row)", () => {
    const event: StoredSessionEvent = { type: "operator-turn-recorded", sourceId: "src-1" };
    expect(wireEventsFromStored(event)).toEqual([]);
  });

  test("assistant-message -> ONE text delta (replay's reconstruction)", () => {
    const event: StoredSessionEvent = { type: "assistant-message", text: "Full reply text." };
    expect(wireEventsFromStored(event)).toEqual([
      { event: "text", data: { delta: "Full reply text." } },
    ]);
  });

  test("research-started -> research.started, carrying the stored briefId", () => {
    const event: StoredSessionEvent = {
      type: "research-started",
      brief: brief("Find Linear's spacing scale"),
      briefId: "turn-1/brief-1",
    };
    expect(wireEventsFromStored(event)).toEqual([
      {
        event: "research.started",
        data: { briefId: "turn-1/brief-1", brief: brief("Find Linear's spacing scale") },
      },
    ]);
  });

  test("research-completed -> one research.source per source, then research.finished", () => {
    const source1 = makeSource({ url: "https://a.example/one", title: "A" });
    const source2 = makeSource({ url: "https://b.example/two", title: "B" });
    const result: ResearchResult = {
      findings: [
        { text: "Linear uses a 4px grid.", citations: [{ sourceId: source1.id, quote: "q" }] },
      ],
      sources: [source1, source2],
    };
    const event: StoredSessionEvent = {
      type: "research-completed",
      brief: brief("g"),
      result,
      briefId: "turn-1/brief-1",
    };
    expect(wireEventsFromStored(event)).toEqual([
      {
        event: "research.source",
        data: { sourceId: source1.id, url: source1.url, title: source1.title },
      },
      {
        event: "research.source",
        data: { sourceId: source2.id, url: source2.url, title: source2.title },
      },
      {
        event: "research.finished",
        data: { briefId: "turn-1/brief-1", findings: result.findings },
      },
    ]);
  });

  test("research-completed with no sources -> only research.finished", () => {
    const result: ResearchResult = { findings: [], sources: [] };
    const event: StoredSessionEvent = {
      type: "research-completed",
      brief: brief("g"),
      result,
      briefId: "turn-1/brief-1",
    };
    expect(wireEventsFromStored(event)).toEqual([
      { event: "research.finished", data: { briefId: "turn-1/brief-1", findings: [] } },
    ]);
  });

  test("research-failed -> research.failed (no doc row, forwarded anyway)", () => {
    const event: StoredSessionEvent = {
      type: "research-failed",
      brief: brief("g"),
      error: "fetch timed out",
      briefId: "turn-1/brief-1",
    };
    expect(wireEventsFromStored(event)).toEqual([
      {
        event: "research.failed",
        data: { briefId: "turn-1/brief-1", brief: brief("g"), error: "fetch timed out" },
      },
    ]);
  });

  test("chapter-drafted -> chapter.drafted", () => {
    const event: StoredSessionEvent = { type: "chapter-drafted", volume, chapter };
    expect(wireEventsFromStored(event)).toEqual([
      { event: "chapter.drafted", data: { volume, chapter } },
    ]);
  });

  test("chapter-audit -> one chapter.restated per repair, then audit", () => {
    const repair: RepairDecision = {
      claimId: fixtureClaimId(),
      label: "lin-grid",
      chapter: "spacing",
      from: "Linear uses a 4px grid everywhere.",
      to: "Linear uses a 4px grid in most places (as far as I can confirm).",
      reason: "softened to what the transcript supports",
      levenshtein: 12,
      bound: 20,
      outcome: "applied",
    };
    const event: StoredSessionEvent = {
      type: "chapter-audit",
      volume,
      chapter,
      passed: false,
      repairs: [repair],
    };
    expect(wireEventsFromStored(event)).toEqual([
      {
        event: "chapter.restated",
        data: {
          claim: repair.label,
          from: repair.from,
          to: repair.to,
          reason: repair.reason,
          outcome: repair.outcome,
        },
      },
      { event: "audit", data: { volume, chapter, passed: false, repairs: [repair] } },
    ]);
  });

  test("chapter-audit with no repairs -> only audit", () => {
    const event: StoredSessionEvent = {
      type: "chapter-audit",
      volume,
      chapter,
      passed: true,
      repairs: [],
    };
    expect(wireEventsFromStored(event)).toEqual([
      { event: "audit", data: { volume, chapter, passed: true, repairs: [] } },
    ]);
  });

  test("chapter-published -> chapter.published (no doc row)", () => {
    const event: StoredSessionEvent = { type: "chapter-published", volume, chapter };
    expect(wireEventsFromStored(event)).toEqual([
      { event: "chapter.published", data: { volume, chapter } },
    ]);
  });

  test("chapter-rejected -> chapter.rejected, with issues", () => {
    const issues: readonly CheckIssue[] = [
      { code: "unbound-citation", message: "bad", label: "lin-grid" },
    ];
    const event: StoredSessionEvent = { type: "chapter-rejected", volume, chapter, issues };
    expect(wireEventsFromStored(event)).toEqual([
      { event: "chapter.rejected", data: { volume, chapter, issues } },
    ]);
  });

  test("error -> error, with the fixed shadow_turn_error code", () => {
    const event: StoredSessionEvent = { type: "error", error: "the model call failed" };
    expect(wireEventsFromStored(event)).toEqual([
      { event: "error", data: { message: "the model call failed", code: "shadow_turn_error" } },
    ]);
  });

  test("turn-boundary (started/ended-error) -> no wire representation", () => {
    expect(wireEventsFromStored(turnBoundaryStarted())).toEqual([]);
    // ended/error's content is carried by `errorEventForBoundary` instead
    // (tested separately, below) — `wireEventsFromStored` itself still maps
    // it to nothing.
    expect(
      wireEventsFromStored(turnBoundaryEnded("error", { message: "boom", code: "internal_error" })),
    ).toEqual([]);
  });

  // T2.8: the one `turn-boundary` shape that DOES get a wire event — a
  // replaying client has no other way to learn a turn stalled with no
  // further events ever coming for it (`event-mapping.ts`'s module doc).
  test("turn-boundary (ended/interrupted) -> turn.interrupted", () => {
    expect(wireEventsFromStored(turnBoundaryEnded("interrupted"))).toEqual([
      { event: "turn.interrupted", data: {} },
    ]);
  });

  // F3 review fix: the OTHER `turn-boundary` outcome that now gets a wire
  // event — without it, a `?follow=true` viewer's `turnPending` had no way
  // to learn a turn it's watching completed normally (`?follow=true` never
  // sends `done`), so a later connection blip on an already-finished turn
  // got mis-marked `turn.interrupted` with a live Retry.
  test("turn-boundary (ended/completed) -> turn.ended", () => {
    expect(wireEventsFromStored(turnBoundaryEnded("completed"))).toEqual([
      { event: "turn.ended", data: {} },
    ]);
  });

  test("turnBoundaryEnded('error', ...) requires an error payload", () => {
    expect(() => turnBoundaryEnded("error")).toThrow();
  });

  test("an unrecognized stored event type -> dropped, not thrown (forward compat)", () => {
    const event: StoredSessionEvent = { type: "some-future-event", foo: "bar" };
    expect(wireEventsFromStored(event)).toEqual([]);
  });
});

describe("wireEventsForLive — differs from wireEventsFromStored only for assistant-message", () => {
  test("assistant-message maps to nothing live (already streamed as text-deltas)", () => {
    const event: StoredSessionEvent = { type: "assistant-message", text: "Full reply text." };
    expect(wireEventsForLive(event)).toEqual([]);
    // ...but replay still needs it — this is the one deliberate divergence.
    expect(wireEventsFromStored(event)).not.toEqual([]);
  });

  test("every other stored event type maps identically live and replayed", () => {
    const samples: readonly StoredSessionEvent[] = [
      operatorMessageEvent("hi"),
      { type: "operator-turn-recorded", sourceId: "src-1" },
      { type: "research-started", brief: brief("g"), briefId: "t/brief-1" },
      { type: "chapter-drafted", volume, chapter },
      { type: "chapter-published", volume, chapter },
      { type: "error", error: "boom" },
      turnBoundaryStarted(),
      turnBoundaryEnded("completed"),
    ];
    for (const event of samples) {
      expect(wireEventsForLive(event)).toEqual(wireEventsFromStored(event));
    }
  });
});

describe("StoredEventStamper — briefId assignment/correlation", () => {
  test("research-started mints '<turnId>/brief-<n>', starting at 1, incrementing per brief in the turn", () => {
    const stamper = new StoredEventStamper("turn-abc");
    const b1 = brief("first");
    const b2 = brief("second");

    const started1 = stamper.stampAgentEvent({ type: "research-started", brief: b1 });
    const started2 = stamper.stampAgentEvent({ type: "research-started", brief: b2 });

    expect(started1).toMatchObject({ type: "research-started", briefId: "turn-abc/brief-1" });
    expect(started2).toMatchObject({ type: "research-started", briefId: "turn-abc/brief-2" });
  });

  test("research-completed/-failed correlate to the SAME briefId as their research-started, by object identity", () => {
    const stamper = new StoredEventStamper("turn-abc");
    const b1 = brief("first");
    const b2 = brief("second");
    const result: ResearchResult = { findings: [], sources: [] };

    stamper.stampAgentEvent({ type: "research-started", brief: b1 });
    stamper.stampAgentEvent({ type: "research-started", brief: b2 });

    const completed1 = stamper.stampAgentEvent({ type: "research-completed", brief: b1, result });
    const failed2 = stamper.stampAgentEvent({ type: "research-failed", brief: b2, error: "e" });

    expect(completed1).toMatchObject({ briefId: "turn-abc/brief-1" });
    expect(failed2).toMatchObject({ briefId: "turn-abc/brief-2" });
  });

  test("briefIds are unique across turns — two stampers, same brief object, different turnId prefixes", () => {
    const b = brief("shared object");
    const turnA = new StoredEventStamper("turn-A").stampAgentEvent({
      type: "research-started",
      brief: b,
    });
    const turnB = new StoredEventStamper("turn-B").stampAgentEvent({
      type: "research-started",
      brief: b,
    });
    expect(turnA).toMatchObject({ briefId: "turn-A/brief-1" });
    expect(turnB).toMatchObject({ briefId: "turn-B/brief-1" });
  });

  test("a lookup miss (no matching research-started seen) falls back to a stable placeholder rather than throwing", () => {
    const stamper = new StoredEventStamper("turn-abc");
    const result: ResearchResult = { findings: [], sources: [] };
    const completed = stamper.stampAgentEvent({
      type: "research-completed",
      brief: brief("never started"),
      result,
    });
    expect(completed).toMatchObject({ briefId: "turn-abc/brief-unknown-1" });
  });

  // Review #9: a stored "brief-unknown" placeholder is permanent replay
  // corruption the moment a second miss happens in the same turn — two
  // misses rendering as the literal same briefId would be indistinguishable
  // on replay forever after. Each miss must mint its own unique id.
  test("two lookup misses in the same turn get distinct placeholder briefIds, not the same one twice", () => {
    const stamper = new StoredEventStamper("turn-xyz");
    const result: ResearchResult = { findings: [], sources: [] };
    const firstMiss = stamper.stampAgentEvent({
      type: "research-completed",
      brief: brief("never started 1"),
      result,
    });
    const secondMiss = stamper.stampAgentEvent({
      type: "research-failed",
      brief: brief("never started 2"),
      error: "boom",
    });
    expect(firstMiss).toMatchObject({ briefId: "turn-xyz/brief-unknown-1" });
    expect(secondMiss).toMatchObject({ briefId: "turn-xyz/brief-unknown-2" });
    expect((firstMiss as { briefId: string }).briefId).not.toBe(
      (secondMiss as { briefId: string }).briefId,
    );
  });

  test("non-research events pass through unchanged", () => {
    const stamper = new StoredEventStamper("turn-abc");
    const event: ShadowEvent = { type: "chapter-drafted", volume, chapter };
    expect(stamper.stampAgentEvent(event)).toEqual(event);
  });
});

/**
 * Simulates `handlers/chat.ts`'s live loop over a raw `ShadowEvent[]`
 * (`text-delta` streamed straight through; every other event stamped then
 * mapped via `wireEventsForLive`), plus the `operator` event chat.ts emits
 * up front. Mirrors the handler closely enough that a drift there would
 * show up as a drift here.
 */
function runLive(
  operatorText: string,
  events: readonly ShadowEvent[],
  turnId: string,
): WireEvent[] {
  const stamper = new StoredEventStamper(turnId);
  const wire: WireEvent[] = [...wireEventsForLive(operatorMessageEvent(operatorText))];
  for (const event of events) {
    if (event.type === "text-delta") {
      wire.push({ event: "text", data: { delta: event.text } });
      continue;
    }
    wire.push(...wireEventsForLive(stamper.stampAgentEvent(event)));
  }
  return wire;
}

/**
 * Approximates the `StoredSessionEvent[]` T2.5's tee will append for the
 * same turn (`operator-message`, `turn-boundary(started)`, every non-delta
 * `ShadowEvent` stamped, `turn-boundary(ended, "completed")`) — always
 * `"completed"` regardless of what `events` actually contains, which is a
 * simplification the two call sites below account for by excluding
 * `turn.ended` from their live/replay comparison (see their own doc) rather
 * than this helper trying to infer the "real" end reason. Then replays it
 * through `wireEventsFromStored`, exactly what T2.7's replay endpoint will
 * do.
 */
function runStoredThenReplay(
  operatorText: string,
  events: readonly ShadowEvent[],
  turnId: string,
): WireEvent[] {
  const stamper = new StoredEventStamper(turnId);
  const stored: StoredSessionEvent[] = [operatorMessageEvent(operatorText), turnBoundaryStarted()];
  for (const event of events) {
    if (event.type === "text-delta") continue; // never stored
    stored.push(stamper.stampAgentEvent(event));
  }
  stored.push(turnBoundaryEnded("completed"));
  return stored.flatMap(wireEventsFromStored);
}

describe("live vs replay — identical wire sequences for the same turn", () => {
  test("a full turn (deltas, research, chapter publication) — same non-text wire events, same briefIds, same concatenated text", () => {
    const b1 = brief("research the grid");
    const source = makeSource({ url: "https://linear.app/blog", title: "Linear's design system" });
    const result: ResearchResult = {
      findings: [
        { text: "Linear uses a 4px grid.", citations: [{ sourceId: source.id, quote: "q" }] },
      ],
      sources: [source],
    };
    const events: ShadowEvent[] = [
      { type: "operator-turn-recorded", sourceId: "src-op" },
      { type: "research-started", brief: b1 },
      { type: "research-completed", brief: b1, result },
      { type: "text-delta", text: "Here" },
      { type: "text-delta", text: " you go." },
      { type: "assistant-message", text: "Here you go." },
      { type: "chapter-drafted", volume, chapter },
      { type: "chapter-audit", volume, chapter, passed: true, repairs: [] },
      { type: "chapter-published", volume, chapter },
    ];

    const live = runLive("Please research and write the spacing chapter.", events, "turn-1");
    const replayed = runStoredThenReplay(
      "Please research and write the spacing chapter.",
      events,
      "turn-1",
    );

    // Both start with the same operator bubble.
    expect(live[0]).toEqual({
      event: "operator",
      data: { text: "Please research and write the spacing chapter." },
    });
    expect(replayed[0]).toEqual(live[0]);

    // Every non-text wire event is byte-identical, in the same order,
    // between the live stream and the replayed one — including the
    // research briefId, which round-tripped through a stored/replayed
    // record rather than surviving by object identity. `turn.ended`/
    // `turn.interrupted` are excluded on purpose (F3 review fix): both are
    // T2.7's replay+follow-only wire events — `runLive` mirrors
    // `chat.ts`'s real behavior of never running a `turn-boundary` record
    // through this mapping at all (this module's own doc), so a genuine
    // live stream never produces either one; only `runStoredThenReplay`'s
    // synthetic trailing boundary does.
    const comparable = (list: WireEvent[]) =>
      list.filter(
        (w) => w.event !== "text" && w.event !== "turn.ended" && w.event !== "turn.interrupted",
      );
    expect(comparable(replayed)).toEqual(comparable(live));

    // The text itself: live sent it as separate deltas that concatenate to
    // the same string replay sends as one delta (the one documented,
    // deliberate divergence — see `wireEventsForLive`'s doc).
    const liveText = live
      .filter((w) => w.event === "text")
      .map((w) => (w.data as { delta: string }).delta)
      .join("");
    const replayedTextEvents = replayed.filter((w) => w.event === "text");
    expect(replayedTextEvents).toHaveLength(1);
    expect(dataOfFirst<{ delta: string }>(replayedTextEvents, "text").delta).toBe(liveText);
    expect(liveText).toBe("Here you go.");

    // The research briefId agrees between the live stream and the replay.
    const liveBriefId = dataOfFirst<{ briefId: string }>(live, "research.started").briefId;
    const replayedBriefId = dataOfFirst<{ briefId: string }>(replayed, "research.started").briefId;
    expect(replayedBriefId).toBe(liveBriefId);
    expect(liveBriefId).toBe("turn-1/brief-1");
  });

  test("briefIds are stable across repeated replays of the same stored sequence", () => {
    const b = brief("research something");
    const result: ResearchResult = { findings: [], sources: [] };
    const events: StampableAgentEvent[] = [
      { type: "research-started", brief: b },
      { type: "research-completed", brief: b, result },
    ];
    const stamper = new StoredEventStamper("turn-9");
    const stored: StoredSessionEvent[] = events.map((e) => stamper.stampAgentEvent(e));

    const firstReplay = stored.flatMap(wireEventsFromStored);
    const secondReplay = stored.flatMap(wireEventsFromStored);
    expect(secondReplay).toEqual(firstReplay);

    const briefIds = firstReplay
      .filter((w) => w.event === "research.started" || w.event === "research.finished")
      .map((w) => (w.data as { briefId: string }).briefId);
    expect(briefIds).toEqual(["turn-9/brief-1", "turn-9/brief-1"]);
  });

  test("briefIds are unique across two turns replayed independently, even for structurally identical briefs", () => {
    const turn1Events: StampableAgentEvent[] = [
      { type: "research-started", brief: brief("same goal") },
    ];
    const turn2Events: StampableAgentEvent[] = [
      { type: "research-started", brief: brief("same goal") },
    ];

    const stored1 = turn1Events.map((e) => new StoredEventStamper("turn-1").stampAgentEvent(e));
    const stored2 = turn2Events.map((e) => new StoredEventStamper("turn-2").stampAgentEvent(e));

    const replay1 = stored1.flatMap(wireEventsFromStored);
    const replay2 = stored2.flatMap(wireEventsFromStored);

    const id1 = dataOfFirst<{ briefId: string }>(replay1, "research.started").briefId;
    const id2 = dataOfFirst<{ briefId: string }>(replay2, "research.started").briefId;
    expect(id1).toBe("turn-1/brief-1");
    expect(id2).toBe("turn-2/brief-1");
    expect(id1).not.toBe(id2);
  });

  test("an error mid-turn maps identically live and replayed", () => {
    const events: ShadowEvent[] = [
      { type: "text-delta", text: "partial" },
      { type: "error", error: "the model call failed" },
    ];
    const live = runLive("do something", events, "turn-e");
    const replayed = runStoredThenReplay("do something", events, "turn-e");

    // See the identical helper's doc above for why `turn.ended`/
    // `turn.interrupted` are excluded.
    const comparable = (list: WireEvent[]) =>
      list.filter(
        (w) => w.event !== "text" && w.event !== "turn.ended" && w.event !== "turn.interrupted",
      );
    expect(comparable(replayed)).toEqual(comparable(live));
    expect(live.at(-1)).toEqual({
      event: "error",
      data: { message: "the model call failed", code: "shadow_turn_error" },
    });
  });
});
