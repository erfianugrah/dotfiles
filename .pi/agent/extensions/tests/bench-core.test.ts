/**
 * bench-core unit tests - pure hyperfine projection + arg-building + rendering.
 * No hyperfine binary needed (live run [blocked: needs binary]).
 *
 *   bun test extensions/tests/bench-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import { buildBenchArgs, fmtSeconds, parseHyperfineJson, renderBench } from "../lib/bench-core.ts";

const HF = JSON.stringify({
  results: [
    { command: "./new", mean: 0.5, stddev: 0.01, min: 0.48, max: 0.52, median: 0.5, times: [0.5, 0.5], exit_codes: [0, 0] },
    { command: "./old", mean: 1.0, stddev: 0.02, min: 0.98, max: 1.03, median: 1.0, times: [1.0, 1.0], exit_codes: [0, 0] },
  ],
});

describe("bench-core.buildBenchArgs", () => {
  test("defaults: warmup 3, runs 10, export json, shell=none, then commands", () => {
    expect(buildBenchArgs({ commands: ["a", "b"] }, "/tmp/x.json")).toEqual([
      "--warmup", "3", "--runs", "10", "--export-json", "/tmp/x.json", "--shell=none", "a", "b",
    ]);
  });
  test("shell_none=false omits --shell=none; prepare adds --prepare", () => {
    const args = buildBenchArgs({ commands: ["a"], shellNone: false, prepare: "rm -rf x", warmup: 1, runs: 2 }, "/e.json");
    expect(args).not.toContain("--shell=none");
    expect(args).toContain("--prepare");
    expect(args).toContain("rm -rf x");
    expect(args.slice(0, 6)).toEqual(["--warmup", "1", "--runs", "2", "--export-json", "/e.json"]);
  });
});

describe("bench-core.parseHyperfineJson", () => {
  const out = parseHyperfineJson(HF);
  test("projects results and picks fastest as winner", () => {
    expect(out.results.length).toBe(2);
    expect(out.winner).toBe("./new");
    expect(out.results[0].runs).toBe(2);
  });
  test("speedup = slowest.mean / fastest.mean", () => {
    expect(out.speedupX).toBeCloseTo(2.0, 5);
  });
  test("malformed -> empty", () => {
    expect(parseHyperfineJson("nope")).toEqual({ results: [], winner: null, speedupX: null });
  });
});

describe("bench-core.fmtSeconds", () => {
  test("scales units", () => {
    expect(fmtSeconds(0.0005)).toContain("µs");
    expect(fmtSeconds(0.05)).toBe("50.0 ms");
    expect(fmtSeconds(2.5)).toBe("2.500 s");
    expect(fmtSeconds(90)).toBe("1.50 min");
  });
});

describe("bench-core.renderBench", () => {
  test("marks winner + reports speedup", () => {
    const text = renderBench(parseHyperfineJson(HF));
    expect(text).toContain("Benchmark results:");
    expect(text).toContain("* ./new");
    expect(text).toContain("Winner: ./new (2.00");
    expect(text).toContain("faster than slowest");
  });
});
