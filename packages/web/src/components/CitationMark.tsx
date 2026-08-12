import type { Tone } from "./Badge.tsx";

/**
 * The clickable citation marker rendered inline in chapter prose. Tone is
 * the semantic colour rule in miniature: clay by default (this is sourced),
 * red when the claim failed its audit, amber when its citation has drifted
 * (orphaned, D22 — a warning, never a failure), sage when the claim cites
 * the operator's own words rather than an external source (D19's `operator`
 * kind — still a citation, but "this is yours").
 */
export function CitationMark({
  label,
  number,
  tone,
  onClick,
}: {
  readonly label: string;
  /** This claim's 1-based position among citations in the chapter, in reading order — the visible mark, so the prose carries a short numeral instead of the raw `[^label]` text. */
  readonly number: number;
  readonly tone: Tone;
  readonly onClick: () => void;
}) {
  return (
    <sup>
      <button
        type="button"
        className={`citation-mark citation-mark--${tone}`}
        data-tone={tone}
        aria-label={`Citation ${label} (${number})${describeTone(tone)}, opens evidence snapshot`}
        onClick={onClick}
      >
        {number}
      </button>
    </sup>
  );
}

function describeTone(tone: Tone): string {
  switch (tone) {
    case "red":
      return ", audit failed";
    case "amber":
      return ", source drifted";
    case "sage":
      return ", operator's own words";
    default:
      return "";
  }
}
