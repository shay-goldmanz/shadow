import type { ReactNode } from "react";

/**
 * The four semantic tones from D10: sage ("yours / active"), clay ("sourced" —
 * the citation colour), amber ("not yet grounded"), red ("audit failed").
 * `neutral` is the only non-semantic tone, for chrome that carries no
 * evidence meaning (counts, timestamps).
 */
export type Tone = "sage" | "clay" | "amber" | "red" | "neutral";

export function Badge({ tone, children }: { readonly tone: Tone; readonly children: ReactNode }) {
  return (
    <span className={`badge badge--${tone}`} data-tone={tone}>
      {children}
    </span>
  );
}
