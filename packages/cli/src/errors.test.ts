import { describe, expect, test } from "bun:test";
import { VolumeNotFoundError } from "@shadow/core";
import { NodeNotFoundError } from "@shadow/indexing";
import {
  IndexMissingError,
  NodeLookupError,
  ShadowCliError,
  SkillAlreadyInstalledError,
  StaleIndexError,
  UnexpectedCliError,
  UsageError,
  VolumeLookupError,
} from "./errors.ts";

/** Every error this package can throw, so the exhaustive "next_steps on every error" assertion has one place to grow from. */
const ALL_ERRORS: readonly ShadowCliError[] = [
  new UsageError("find", "task is required"),
  new IndexMissingError(),
  new StaleIndexError("sha256:aaa", "sha256:bbb"),
  new VolumeLookupError(new VolumeNotFoundError("missing-volume")),
  new NodeLookupError(new NodeNotFoundError("bad-node-id")),
  new SkillAlreadyInstalledError("/tmp/repo/.claude/skills/shadow-find/SKILL.md"),
  new UnexpectedCliError(new Error("boom")),
];

describe("every ShadowCliError", () => {
  for (const error of ALL_ERRORS) {
    test(`${error.name} carries a non-empty next_steps and a distinct positive exit code`, () => {
      expect(error).toBeInstanceOf(ShadowCliError);
      expect(error).toBeInstanceOf(Error);
      expect(Array.isArray(error.nextSteps)).toBe(true);
      expect(error.nextSteps.length).toBeGreaterThan(0);
      for (const step of error.nextSteps) {
        expect(typeof step).toBe("string");
        expect(step.length).toBeGreaterThan(0);
      }
      expect(Number.isInteger(error.exitCode)).toBe(true);
      expect(error.exitCode).toBeGreaterThan(0);
    });

    test(`${error.name}.toEnvelope() puts next_steps alongside a structured error`, () => {
      const envelope = error.toEnvelope();
      expect(envelope.error.name).toBe(error.name);
      expect(envelope.error.message).toBe(error.message);
      expect(envelope.next_steps).toEqual(error.nextSteps);
    });
  }

  test("exit codes group into meaningful, documented categories", () => {
    // VolumeLookupError and NodeLookupError intentionally share exit code 3
    // ("not found") — a scripted caller branches on the code, not the
    // class name, and both mean the same thing to a script. Every other
    // kind gets its own code.
    expect(new UsageError("x", "y").exitCode).toBe(2);
    expect(new IndexMissingError().exitCode).toBe(4);
    expect(new StaleIndexError(undefined, "h").exitCode).toBe(5);
    expect(new VolumeLookupError(new VolumeNotFoundError("v")).exitCode).toBe(3);
    expect(new NodeLookupError(new NodeNotFoundError("n")).exitCode).toBe(3);
    expect(new SkillAlreadyInstalledError("/tmp/x/SKILL.md").exitCode).toBe(6);
    expect(new UnexpectedCliError(new Error("e")).exitCode).toBe(1);
  });
});

describe("UsageError message formatting", () => {
  test("includes the command name when one is known", () => {
    expect(new UsageError("chapters", "missing <volume> argument").message).toBe(
      "shadow chapters: missing <volume> argument",
    );
  });

  test("omits the redundant space/colon when there is no specific command (e.g. an unrecognized top-level command)", () => {
    expect(new UsageError("", 'unknown command "bogus"').message).toBe(
      'shadow: unknown command "bogus"',
    );
  });
});

describe("VolumeLookupError / NodeLookupError", () => {
  test("wrap the underlying typed error as `cause` rather than swallowing it", () => {
    const underlying = new VolumeNotFoundError("missing-volume");
    const wrapped = new VolumeLookupError(underlying);
    expect(wrapped.cause).toBe(underlying);
  });
});
