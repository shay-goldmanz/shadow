import { type ThemePreference, useTheme } from "./ThemeProvider.tsx";

const OPTIONS: readonly { readonly value: ThemePreference; readonly label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/** A three-way segmented control. Each option is a real button, so it is keyboard-reachable without custom key handling. */
export function ThemeToggle() {
  const { preference, setPreference } = useTheme();

  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className="theme-toggle__option"
          aria-pressed={preference === option.value}
          onClick={() => setPreference(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
