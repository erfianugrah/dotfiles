/**
 * Unit tests for the pure helpers in cost-guard.ts.
 *
 * Fixtures use SYNTHETIC providers/ids/prices (round numbers) - they
 * exercise the math, not any real model's rate card.
 *
 * Run: ./.pi/agent/tests/run.sh cost-guard
 */

import { describe, expect, test } from "bun:test";

import {
  parseLadder,
  thresholdsCrossed,
  perTurnCostUSD,
  cheaperAlternatives,
  fmtUSD,
  type CostedModel,
} from "../extensions/cost-guard.ts";

const LADDER = [5, 10, 20, 35, 50, 75, 100];

describe("parseLadder", () => {
  test("undefined returns fallback", () => {
    expect(parseLadder(undefined, LADDER)).toEqual(LADDER);
  });
  test("parses, sorts, drops junk", () => {
    expect(parseLadder("20, 5,abc,-3,10", LADDER)).toEqual([5, 10, 20]);
  });
  test("all-junk returns fallback", () => {
    expect(parseLadder("x,y", LADDER)).toEqual(LADDER);
  });
});

describe("thresholdsCrossed", () => {
  test("no movement crosses nothing", () => {
    expect(thresholdsCrossed(10, 10, LADDER, 50)).toEqual([]);
    expect(thresholdsCrossed(10, 8, LADDER, 50)).toEqual([]);
  });
  test("crosses a single rung", () => {
    expect(thresholdsCrossed(4, 6, LADDER, 50)).toEqual([5]);
  });
  test("one big jump crosses multiple rungs", () => {
    expect(thresholdsCrossed(0, 36, LADDER, 50)).toEqual([5, 10, 20, 35]);
  });
  test("landing exactly on a rung crosses it", () => {
    expect(thresholdsCrossed(19, 20, LADDER, 50)).toEqual([20]);
  });
  test("past the ladder, every step crossing fires", () => {
    expect(thresholdsCrossed(100, 155, LADDER, 50)).toEqual([150]);
    expect(thresholdsCrossed(100, 260, LADDER, 50)).toEqual([150, 200, 250]);
  });
  test("straddling ladder end and first step", () => {
    expect(thresholdsCrossed(90, 151, LADDER, 50)).toEqual([100, 150]);
  });
  test("between steps past the ladder crosses nothing", () => {
    expect(thresholdsCrossed(151, 199, LADDER, 50)).toEqual([]);
  });
});

describe("perTurnCostUSD", () => {
  test("$10/M input at 500k context = $5", () => {
    expect(perTurnCostUSD({ input: 10, output: 40 }, 500_000)).toBeCloseTo(5);
  });
  test("free local model is $0", () => {
    expect(perTurnCostUSD({ input: 0, output: 0 }, 500_000)).toBe(0);
  });
});

describe("cheaperAlternatives", () => {
  // Synthetic fixture set - prices are round numbers, not real rate cards.
  const bigExpensive: CostedModel = {
    provider: "testprovider",
    id: "big-expensive",
    contextWindow: 1_000_000,
    cost: { input: 10, output: 40 },
  };
  const mid: CostedModel = {
    provider: "testprovider",
    id: "mid",
    contextWindow: 400_000,
    cost: { input: 2, output: 8 },
  };
  const small: CostedModel = {
    provider: "testprovider",
    id: "small-cheap",
    contextWindow: 256_000,
    cost: { input: 0.5, output: 2 },
  };
  const freeLocal: CostedModel = {
    provider: "llama-server",
    id: "local-free",
    contextWindow: 131_072,
    cost: { input: 0, output: 0 },
  };
  const pricier: CostedModel = {
    provider: "testprovider",
    id: "even-pricier",
    contextWindow: 1_000_000,
    cost: { input: 30, output: 120 },
  };
  const all = [bigExpensive, mid, small, freeLocal, pricier];

  test("excludes current, pricier, and too-small-window models", () => {
    // 300k context: mid (400k) fits, small (256k) does NOT, local (131k) does NOT.
    const alts = cheaperAlternatives(all, bigExpensive, 300_000);
    expect(alts.map((a) => a.ref)).toEqual(["testprovider/mid"]);
  });
  test("sorted by per-turn cost ascending, free local first", () => {
    // 100k context: everything fits; local($0) < small < mid.
    const alts = cheaperAlternatives(all, bigExpensive, 100_000);
    expect(alts.map((a) => a.ref)).toEqual([
      "llama-server/local-free",
      "testprovider/small-cheap",
      "testprovider/mid",
    ]);
    expect(alts[0].perTurnUSD).toBe(0);
    expect(alts[1].perTurnUSD).toBeCloseTo(0.05);
  });
  test("limit caps the list", () => {
    expect(cheaperAlternatives(all, bigExpensive, 100_000, 1)).toHaveLength(1);
  });
  test("nothing cheaper that fits -> empty", () => {
    expect(cheaperAlternatives([bigExpensive], bigExpensive, 100_000)).toEqual([]);
    // context bigger than every alternative's window
    expect(cheaperAlternatives(all, bigExpensive, 900_000)).toEqual([]);
  });
});

describe("fmtUSD", () => {
  test("zero, sub-cent, sub-dollar, normal, large", () => {
    expect(fmtUSD(0)).toBe("$0");
    expect(fmtUSD(0.0042)).toBe("$0.0042");
    expect(fmtUSD(0.42)).toBe("$0.420");
    expect(fmtUSD(45.6)).toBe("$45.60");
    expect(fmtUSD(370.4)).toBe("$370");
  });
});
