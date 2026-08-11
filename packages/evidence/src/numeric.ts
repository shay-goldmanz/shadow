/**
 * The numeric sub-check (part of C2, `docs/EVIDENCE.md`): "every numeral in
 * a claim appears in a cited span within 5% relative tolerance." Called out
 * in the spec as "the cheapest high-value thing here" — Science One's
 * highest-confidence result (98.1% numerical provenance) is exactly this
 * kind of deterministic, model-free comparison.
 *
 * Two pieces: extracting numerals from text (with an allowlist for classes
 * that look numeric but aren't quantities to be tolerance-checked — version
 * numbers, dates, hex values), and comparing a claim's numerals against a
 * set of cited spans.
 */

export type NumeralClass = "plain" | "version" | "date" | "hex";

export interface Numeral {
  readonly raw: string;
  readonly value: number;
  readonly start: number;
  readonly end: number;
  readonly klass: NumeralClass;
}

// Order matters: more specific patterns (hex, dates, versions) are tried
// before the generic plain-number pattern, and the scan advances past
// whichever candidate wins so a version number's dot-separated components
// are never independently re-matched as plain decimals.

// #RRGGBB / #RGB, or 0x-prefixed hex.
const HEX_PATTERN = /(#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b)|(\b0x[0-9a-fA-F]+\b)/g;

// ISO-ish dates (2024-03-11), and slash dates (03/11/2024, 3/11/24).
const DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;

// Semver-ish / dotted version numbers: 2+ numeric groups joined by dots,
// optionally preceded by a bare "v" (v2.0.1, 18.2, 7.0.2001), OR a single
// number immediately preceded by a product-name-style capital letter token
// and no unit — deliberately conservative: we only allowlist the
// unambiguous dotted-number shape here, plus an explicit "v" prefix.
const VERSION_PATTERN = /\bv\d+(?:\.\d+){0,3}\b|\b\d+\.\d+(?:\.\d+){1,3}\b/gi;

// Plain numerals: integers/decimals, optional thousands separators,
// optional trailing %, optional leading currency symbol. The first
// alternative requires at least one comma group so it only fires for
// genuinely comma-grouped numbers ("3,000"); otherwise the second,
// ungrouped alternative greedily consumes the whole contiguous digit run
// ("48213") instead of splitting it into 3-digit chunks.
const PLAIN_PATTERN = /[$€£]?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|[$€£]?\d+(?:\.\d+)?%?/g;

function toValue(raw: string): number {
  const cleaned = raw.replace(/[$€£,%]/g, "");
  return Number.parseFloat(cleaned);
}

/**
 * For allowlisted classes (`hex`, `date`, `version`), `raw` may not parse as
 * a plain decimal at all (`#7C9885`, `0x1A2B`) — that's fine, since these
 * are never compared numerically; they only need to occupy their span so
 * `PLAIN_PATTERN` doesn't re-match a substring of them. `0` is a safe,
 * unused placeholder for those. Only `plain` numerals require an actual
 * parseable value, since those are the ones the tolerance check compares.
 */
function collectMatches(text: string, pattern: RegExp, klass: NumeralClass): Numeral[] {
  const results: Numeral[] = [];
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    if (raw.length === 0 || match.index === undefined) continue;
    const parsed = toValue(raw);
    if (klass === "plain" && Number.isNaN(parsed)) continue;
    results.push({
      raw,
      value: Number.isNaN(parsed) ? 0 : parsed,
      start: match.index,
      end: match.index + raw.length,
      klass,
    });
  }
  return results;
}

/**
 * Extract every numeral-shaped token from `text`, classified so the numeric
 * sub-check can allowlist version numbers, dates, and hex values rather
 * than tolerance-checking them as quantities.
 */
export function extractNumerals(text: string): Numeral[] {
  const claimed: Array<[number, number]> = [];
  const overlaps = (start: number, end: number): boolean =>
    claimed.some(([s, e]) => start < e && end > s);

  const ordered: Numeral[] = [
    ...collectMatches(text, HEX_PATTERN, "hex"),
    ...collectMatches(text, DATE_PATTERN, "date"),
    ...collectMatches(text, VERSION_PATTERN, "version"),
  ].toSorted((a, b) => a.start - b.start);

  const accepted: Numeral[] = [];
  for (const numeral of ordered) {
    if (overlaps(numeral.start, numeral.end)) continue;
    claimed.push([numeral.start, numeral.end]);
    accepted.push(numeral);
  }

  for (const numeral of collectMatches(text, PLAIN_PATTERN, "plain")) {
    if (overlaps(numeral.start, numeral.end)) continue;
    claimed.push([numeral.start, numeral.end]);
    accepted.push(numeral);
  }

  return accepted.toSorted((a, b) => a.start - b.start);
}

/** Only the tolerance-checkable numerals — allowlisted classes are excluded entirely. */
export function extractCheckableNumerals(text: string): Numeral[] {
  return extractNumerals(text).filter((n) => n.klass === "plain");
}

function withinTolerance(a: number, b: number, relativeTolerance: number): boolean {
  if (a === b) return true;
  const denominator = Math.max(Math.abs(a), Math.abs(b));
  if (denominator === 0) return true;
  return Math.abs(a - b) / denominator <= relativeTolerance;
}

export interface NumeralCheckOutcome {
  readonly numeral: Numeral;
  readonly matched: boolean;
  /** The closest value found among cited spans, if any numerals were present there at all. */
  readonly closestSpanValue?: number;
}

export interface NumericCheckResult {
  readonly passed: boolean;
  readonly outcomes: readonly NumeralCheckOutcome[];
}

/** Default per `docs/EVIDENCE.md`: "within 5% relative tolerance". */
export const DEFAULT_NUMERIC_TOLERANCE = 0.05;

/**
 * Check that every non-allowlisted numeral in `claimText` appears, within
 * `tolerance` relative error, among the numerals found in `citedSpanTexts`
 * (typically the `selector.exact` strings of a claim's evidence spans).
 */
export function checkNumericConsistency(
  claimText: string,
  citedSpanTexts: readonly string[],
  tolerance: number = DEFAULT_NUMERIC_TOLERANCE,
): NumericCheckResult {
  const claimNumerals = extractCheckableNumerals(claimText);
  const spanValues = citedSpanTexts.flatMap((span) =>
    extractCheckableNumerals(span).map((n) => n.value),
  );

  const outcomes: NumeralCheckOutcome[] = claimNumerals.map((numeral) => {
    let closest: number | undefined;
    let closestDistance = Infinity;
    let matched = false;
    for (const spanValue of spanValues) {
      if (withinTolerance(numeral.value, spanValue, tolerance)) {
        matched = true;
      }
      const distance = Math.abs(numeral.value - spanValue);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = spanValue;
      }
    }
    return { numeral, matched, closestSpanValue: closest };
  });

  return { passed: outcomes.every((o) => o.matched), outcomes };
}
