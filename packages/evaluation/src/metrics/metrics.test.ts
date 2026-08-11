import { describe, expect, test } from "bun:test";
import { aggregateScores, type QueryScore, scoreQuery } from "./metrics.ts";

describe("scoreQuery — a perfect single-relevant hit", () => {
  test("precision, recall, RR, nDCG all 1; no holes", () => {
    const score = scoreQuery({ relevant: ["a"], judgedIrrelevant: ["b"] }, ["a"]);
    expect(score.precision).toBe(1);
    expect(score.recall).toBe(1);
    expect(score.reciprocalRank).toBe(1);
    expect(score.ndcg).toBe(1);
    expect(score.holes).toBe(0);
    expect(score.holesRatio).toBe(0);
    expect(score.correctRejection).toBeUndefined();
  });
});

describe("scoreQuery — retrieving a judged-irrelevant chapter", () => {
  test("scores as wrong but is not a hole (it was judged, just negatively)", () => {
    const score = scoreQuery({ relevant: ["a"], judgedIrrelevant: ["b"] }, ["b"]);
    expect(score.precision).toBe(0);
    expect(score.recall).toBe(0);
    expect(score.reciprocalRank).toBe(0);
    expect(score.ndcg).toBe(0);
    expect(score.holes).toBe(0);
    expect(score.holesRatio).toBe(0);
  });
});

describe("scoreQuery — retrieving an unjudged chapter", () => {
  test("is a hole: the golden set never checked it either way", () => {
    const score = scoreQuery({ relevant: ["a"], judgedIrrelevant: ["b"] }, ["c"]);
    expect(score.precision).toBe(0);
    expect(score.holes).toBe(1);
    expect(score.holesRatio).toBe(1);
  });

  test("holesRatio is the fraction of retrieved items unjudged, not a count", () => {
    // 1 relevant hit, 1 judged-irrelevant, 2 unjudged holes, out of 4 retrieved.
    const score = scoreQuery({ relevant: ["a"], judgedIrrelevant: ["b"] }, ["a", "b", "c", "d"]);
    expect(score.holes).toBe(2);
    expect(score.holesRatio).toBe(0.5);
    expect(score.precision).toBe(0.25); // only "a" is a real hit, out of 4 retrieved
  });
});

describe("scoreQuery — retrieving nothing on an answerable query", () => {
  test("precision undefined, recall/RR/nDCG are 0, no holes, no correctRejection verdict", () => {
    const score = scoreQuery({ relevant: ["a"] }, []);
    expect(score.precision).toBeUndefined();
    expect(score.recall).toBe(0);
    expect(score.reciprocalRank).toBe(0);
    expect(score.ndcg).toBe(0);
    expect(score.holes).toBe(0);
    expect(score.holesRatio).toBe(0);
    expect(score.correctRejection).toBeUndefined();
  });
});

describe("scoreQuery — not-in-corpus queries (relevant: [])", () => {
  test("correctly retrieving nothing: correctRejection true, recall/RR/nDCG undefined", () => {
    const score = scoreQuery({ relevant: [], judgedIrrelevant: ["x"] }, []);
    expect(score.correctRejection).toBe(true);
    expect(score.recall).toBeUndefined();
    expect(score.reciprocalRank).toBeUndefined();
    expect(score.ndcg).toBeUndefined();
    expect(score.precision).toBeUndefined();
    expect(score.holes).toBe(0);
  });

  test("wrongly retrieving something: correctRejection false, and an unjudged pick is a hole", () => {
    const score = scoreQuery({ relevant: [] }, ["y"]);
    expect(score.correctRejection).toBe(false);
    expect(score.precision).toBe(0);
    expect(score.holes).toBe(1);
    expect(score.holesRatio).toBe(1);
  });
});

describe("scoreQuery — multi-relevant ranked nDCG (hand-computed)", () => {
  test("matches the DCG/IDCG formula by hand", () => {
    // relevant = {a, b}; retrieved (ranked) = [c(hole), a(hit), b(hit)]
    const score = scoreQuery({ relevant: ["a", "b"] }, ["c", "a", "b"]);
    expect(score.precision).toBeCloseTo(2 / 3, 10);
    expect(score.recall).toBe(1);
    expect(score.reciprocalRank).toBeCloseTo(1 / 2, 10);

    // DCG = gain(rank1=0)/log2(2) + gain(rank2=1)/log2(3) + gain(rank3=1)/log2(4)
    const dcg = 0 + 1 / Math.log2(3) + 1 / Math.log2(4);
    // IDCG = gain(rank1=1)/log2(2) + gain(rank2=1)/log2(3) + gain(rank3=0)/log2(4) (two relevant items placed first)
    const idcg = 1 / Math.log2(2) + 1 / Math.log2(3) + 0;
    expect(score.ndcg).toBeCloseTo(dcg / idcg, 10);
  });
});

describe("aggregateScores", () => {
  test("pools holesRatio across the run rather than averaging per-query ratios", () => {
    const scores: QueryScore[] = [
      // 1 hole out of 2 retrieved
      scoreQuery({ relevant: ["a"] }, ["a", "hole1"]),
      // 3 holes out of 3 retrieved
      scoreQuery({ relevant: ["b"] }, ["hole2", "hole3", "hole4"]),
    ];
    const aggregate = aggregateScores(scores);
    // Pooled: (1 + 3) holes / (2 + 3) retrieved = 4/5 = 0.8
    expect(aggregate.holesRatio).toBeCloseTo(0.8, 10);
    // Mean of per-query ratios: (0.5 + 1) / 2 = 0.75 — different from pooled, deliberately.
    expect(aggregate.meanHolesRatio).toBeCloseTo(0.75, 10);
  });

  test("correctRejectionRate only reflects not-in-corpus queries", () => {
    const scores: QueryScore[] = [
      scoreQuery({ relevant: [] }, []), // correct rejection
      scoreQuery({ relevant: [] }, ["x"]), // wrong: retrieved something
      scoreQuery({ relevant: ["a"] }, ["a"]), // answerable query, irrelevant to the rate
    ];
    const aggregate = aggregateScores(scores);
    expect(aggregate.correctRejectionRate).toBe(0.5);
  });

  test("undefined when the run has no not-in-corpus queries at all", () => {
    const aggregate = aggregateScores([scoreQuery({ relevant: ["a"] }, ["a"])]);
    expect(aggregate.correctRejectionRate).toBeUndefined();
  });

  test("meanPrecision/meanRecall/mrr/meanNdcg skip undefined-scored queries rather than treating them as 0", () => {
    const scores: QueryScore[] = [
      scoreQuery({ relevant: ["a"] }, ["a"]), // precision 1, recall 1, RR 1, ndcg 1
      scoreQuery({ relevant: [] }, []), // not-in-corpus: everything answerable is undefined
    ];
    const aggregate = aggregateScores(scores);
    expect(aggregate.meanPrecision).toBe(1);
    expect(aggregate.meanRecall).toBe(1);
    expect(aggregate.mrr).toBe(1);
    expect(aggregate.meanNdcg).toBe(1);
  });

  test("queryCount matches the input length even when every metric is undefined", () => {
    const aggregate = aggregateScores([]);
    expect(aggregate.queryCount).toBe(0);
    expect(aggregate.meanPrecision).toBeUndefined();
    expect(aggregate.holesRatio).toBe(0);
  });
});
