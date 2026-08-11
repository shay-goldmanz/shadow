import { expect, test } from "bun:test";
import { PACKAGE_NAME } from "./index.ts";

test("exports the package name", () => {
  expect(PACKAGE_NAME).toBe("@shadow/core");
});
