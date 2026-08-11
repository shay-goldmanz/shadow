import "../test/dom-setup.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ThemeProvider } from "./ThemeProvider.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";

// `@testing-library/react`'s `screen` singleton binds to `document` at
// module-load time, before happy-dom registers it (a known Bun + CJS
// interop ordering quirk) — so every test here uses the queries bound by
// `render()` itself, which are always correctly scoped.

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
});

describe("ThemeToggle", () => {
  test("clicking 'Dark' stamps data-theme=dark on <html>", () => {
    const { getByRole } = render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    fireEvent.click(getByRole("button", { name: "Dark" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  test("clicking 'System' after an explicit choice removes the attribute", () => {
    const { getByRole } = render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    fireEvent.click(getByRole("button", { name: "Light" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    fireEvent.click(getByRole("button", { name: "System" }));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  test("the active option is marked aria-pressed", () => {
    const { getByRole } = render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    fireEvent.click(getByRole("button", { name: "Dark" }));
    expect(getByRole("button", { name: "Dark" }).getAttribute("aria-pressed")).toBe("true");
    expect(getByRole("button", { name: "Light" }).getAttribute("aria-pressed")).toBe("false");
  });
});
