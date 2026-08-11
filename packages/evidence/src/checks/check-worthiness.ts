/**
 * C1b — check-worthiness sweep (Tier 2, `docs/EVIDENCE.md`): independently
 * classifies every **unmarked** sentence. This is D19's loophole-closer —
 * the writer marks what it cites, but a separate auditor pass decides what
 * needed citing, from the sentence text alone. If the auditor says a
 * sentence needed a chain and the writer left it unmarked, that is an
 * orphan claim, and the chapter fails.
 *
 * **Silence is what gets audited, structurally, not just by policy.**
 * `segmentChapterBody` reports which sentences already carry a footnote
 * marker, and this function filters those out *before* building the
 * classifier batch (`unmarked` below) — a marked sentence's text never
 * reaches the model here at all. There is no path by which the writer
 * having cited something (or not) can influence the auditor's judgment of
 * a *different*, unmarked sentence; each classification request carries
 * only the sentence, its paragraph context, and the chapter subject.
 *
 * `checkRequired: false` sentences are narrative — the D19 rule this
 * package leans on hardest: **excluded from both the numerator and the
 * denominator of every groundedness metric.** `narrativeRatio` reports the
 * exemption as a visible budget instead, computed here from *all* sentences
 * (marked + unmarked), never gated on pass/fail.
 *
 * Memoized per D20/`docs/EVIDENCE.md` ("only unmarked sentences that are
 * new or changed"): each unmarked sentence hashes to
 * `sha256(context ‖ sentence ‖ chapterSubject)`
 * (`types.ts`'s `NarrativeSentenceClassification` doc). A hash already
 * present in the previous audit's `narrative.classifications` is reused
 * without a model call; only new/changed hashes go into the batch.
 */

import { type Sha256Digest, sha256Of } from "../digest.ts";
import type { CheckWorthinessClassifier, CheckWorthinessInput } from "../ports.ts";
import { type Sentence, segmentChapterBody } from "../sentence-segmentation.ts";
import type { NarrativeSentenceClassification, NarrativeSummary } from "../types.ts";
import type { CheckIssue, CheckOutcome } from "./types.ts";

export interface CheckWorthinessInputBundle {
  readonly chapterBody: string;
  readonly chapterSubject: string;
  readonly classifier: CheckWorthinessClassifier;
  /** The chapter's previously-persisted narrative summary — carries the memoization record. `undefined` on a chapter's first audit. */
  readonly previousNarrative?: NarrativeSummary;
  readonly classifiedBy?: string;
}

export interface CheckWorthinessResult {
  readonly outcome: CheckOutcome;
  readonly narrative: NarrativeSummary;
}

function sentenceHash(sentence: Sentence, chapterSubject: string): Sha256Digest {
  // JSON-encoded, not separator-joined — the same injectivity reasoning as
  // `input-hash.ts`: a fixed separator could collide across a
  // context/sentence boundary, silently reusing a stale verdict.
  return sha256Of(JSON.stringify([sentence.context, sentence.text, chapterSubject]));
}

/** Run C1b over one chapter. See module doc for the memoization and no-influence guarantees. */
export async function checkCheckWorthiness(
  input: CheckWorthinessInputBundle,
): Promise<CheckWorthinessResult> {
  const classifiedBy = input.classifiedBy ?? "llm-judge/claude@shadow-model";
  const sentences = segmentChapterBody(input.chapterBody);
  const unmarked = sentences.filter((s) => !s.marked);

  const previousByHash = new Map<Sha256Digest, NarrativeSentenceClassification>(
    (input.previousNarrative?.classifications ?? []).map((c) => [c.sentenceHash, c]),
  );

  const results = Array.from<NarrativeSentenceClassification | undefined>({
    length: unmarked.length,
  });
  const toClassify: Array<{ sentence: Sentence; hash: Sha256Digest; index: number }> = [];

  unmarked.forEach((sentence, index) => {
    const hash = sentenceHash(sentence, input.chapterSubject);
    const reused = previousByHash.get(hash);
    if (reused) {
      results[index] = reused;
    } else {
      toClassify.push({ sentence, hash, index });
    }
  });

  if (toClassify.length > 0) {
    const requests: CheckWorthinessInput[] = toClassify.map(({ sentence }) => ({
      sentence: sentence.text,
      context: sentence.context,
      chapterSubject: input.chapterSubject,
    }));
    const verdicts = await input.classifier.classify(requests);
    if (verdicts.length !== requests.length) {
      throw new Error(
        `CheckWorthinessClassifier returned ${verdicts.length} verdicts for ${requests.length} sentences`,
      );
    }
    toClassify.forEach(({ hash, index }, i) => {
      const verdict = verdicts[i];
      if (verdict) {
        results[index] = { sentenceHash: hash, checkRequired: verdict.checkRequired };
      }
    });
  }

  const issues: CheckIssue[] = [];
  const classifications: NarrativeSentenceClassification[] = [];
  let narrativeCount = 0;

  unmarked.forEach((sentence, index) => {
    const result = results[index];
    if (!result) return;
    classifications.push(result);
    if (result.checkRequired) {
      issues.push({
        code: "orphan-claim",
        message: `Unmarked sentence needs a citation but has none: "${sentence.text}"`,
      });
    } else {
      narrativeCount += 1;
    }
  });

  const totalSentences = sentences.length;
  const ratio = totalSentences === 0 ? 0 : narrativeCount / totalSentences;

  const narrative: NarrativeSummary = {
    sentences: totalSentences,
    ratio,
    classifiedBy,
    classifications,
  };

  const outcome: CheckOutcome = {
    checkId: "C1b",
    tier: 2,
    blocking: true,
    passed: issues.length === 0,
    issues,
    data: { narrativeRatio: ratio, narrative },
  };

  return { outcome, narrative };
}
