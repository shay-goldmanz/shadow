import { describe, expect, test } from "bun:test";
import { IndexMissingError } from "./errors.ts";
import { renderError, renderSuccess } from "./render.ts";

describe("renderSuccess", () => {
  test("compact by default: single line, no extra whitespace", () => {
    const out = renderSuccess({ a: 1, next_steps: ["do x"] }, { pretty: false });
    expect(out).toBe(`${JSON.stringify({ a: 1, next_steps: ["do x"] })}\n`);
    expect(out.trimEnd().split("\n")).toHaveLength(1);
  });

  test("pretty mode indents", () => {
    const out = renderSuccess({ a: 1 }, { pretty: true });
    expect(out).toContain("\n");
    expect(out).toContain('  "a": 1');
  });

  test("compact output still parses as valid JSON", () => {
    const value = { volumes: [{ volume_id: "v" }], next_steps: ["step"] };
    const out = renderSuccess(value, { pretty: false });
    expect(JSON.parse(out)).toEqual(value);
  });
});

describe("renderError", () => {
  test("renders the error's envelope, including next_steps", () => {
    const error = new IndexMissingError();
    const out = renderError(error, { pretty: false });
    const parsed = JSON.parse(out);
    expect(parsed.error.name).toBe("IndexMissingError");
    expect(parsed.next_steps.length).toBeGreaterThan(0);
  });
});
