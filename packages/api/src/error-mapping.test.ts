import { describe, expect, test } from "bun:test";
import { InvalidSlugError, VolumeNotFoundError } from "@shadow/core";
import { SnapshotNotFoundError } from "@shadow/evidence";
import { toErrorResponse } from "./error-mapping.ts";
import { InvalidRequestError, RouteNotFoundError, SessionNotFoundError } from "./errors.ts";

describe("toErrorResponse", () => {
  test("operator errors (not-found, invalid input) map to 4xx with stable codes", () => {
    expect(toErrorResponse(new VolumeNotFoundError("nope")).status).toBe(404);
    expect(toErrorResponse(new VolumeNotFoundError("nope")).body.error.code).toBe(
      "volume_not_found",
    );

    expect(
      toErrorResponse(new InvalidSlugError("volume", "Bad Slug!", "must be kebab-case")).status,
    ).toBe(400);
    expect(
      toErrorResponse(new InvalidSlugError("volume", "Bad Slug!", "must be kebab-case")).body.error
        .code,
    ).toBe("invalid_slug");

    expect(toErrorResponse(new SnapshotNotFoundError("sha256:abc")).status).toBe(404);
    expect(toErrorResponse(new SnapshotNotFoundError("sha256:abc")).body.error.code).toBe(
      "snapshot_not_found",
    );

    expect(toErrorResponse(new InvalidRequestError("bad body")).status).toBe(400);
    expect(toErrorResponse(new InvalidRequestError("bad body")).body.error.code).toBe(
      "invalid_request",
    );

    expect(toErrorResponse(new SessionNotFoundError("abc")).status).toBe(404);
    expect(toErrorResponse(new RouteNotFoundError("GET", "/nope")).status).toBe(404);
  });

  test("a malformed JSON body maps to 400 invalid_json, not 500", () => {
    let syntaxError: SyntaxError;
    try {
      JSON.parse("{not json");
      throw new Error("unreachable");
    } catch (error) {
      syntaxError = error as SyntaxError;
    }
    const mapped = toErrorResponse(syntaxError);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error.code).toBe("invalid_json");
  });

  test("a genuine, unmapped fault is 500 internal_error", () => {
    const mapped = toErrorResponse(new Error("disk caught fire"));
    expect(mapped.status).toBe(500);
    expect(mapped.body.error.code).toBe("internal_error");
    expect(mapped.body.error.message).toBe("disk caught fire");
  });

  test("a thrown non-Error value is still handled, never throws itself", () => {
    const mapped = toErrorResponse("just a string");
    expect(mapped.status).toBe(500);
    expect(mapped.body.error.code).toBe("internal_error");
  });
});
