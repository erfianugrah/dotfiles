/**
 * go-test-core unit tests - pure JSON projection + arg-building + rendering.
 * No go toolchain needed (live run [blocked: needs binary]).
 *
 *   bun test extensions/tests/go-test-core.test.ts
 */

import { describe, expect, test } from "bun:test";
import { buildGoTestArgs, parseGoTestJson, renderGoTest } from "../lib/go-test-core.ts";

// A realistic `go test -json` event stream: one pass, one fail with output.
const STREAM = [
  { Action: "run", Package: "ex/pkg", Test: "TestOK" },
  { Action: "output", Package: "ex/pkg", Test: "TestOK", Output: "=== RUN   TestOK\n" },
  { Action: "pass", Package: "ex/pkg", Test: "TestOK", Elapsed: 0.01 },
  { Action: "run", Package: "ex/pkg", Test: "TestBad" },
  { Action: "output", Package: "ex/pkg", Test: "TestBad", Output: "    foo_test.go:12: want 1, got 2\n" },
  { Action: "fail", Package: "ex/pkg", Test: "TestBad", Elapsed: 0.02 },
  { Action: "fail", Package: "ex/pkg" },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

describe("go-test-core.buildGoTestArgs", () => {
  test("defaults: test -json -timeout 5m ./...", () => {
    expect(buildGoTestArgs({})).toEqual(["test", "-json", "-timeout", "5m", "./..."]);
  });
  test("flags + run + pattern in order", () => {
    expect(buildGoTestArgs({ race: true, short: true, count: 3, run: "TestX", timeout: "30s", pattern: "./p/..." })).toEqual([
      "test", "-json", "-timeout", "30s", "-race", "-short", "-count=3", "-run", "TestX", "./p/...",
    ]);
  });
  test("count<=1 omits -count", () => {
    expect(buildGoTestArgs({ count: 1 })).not.toContain("-count=1");
  });
});

describe("go-test-core.parseGoTestJson", () => {
  const s = parseGoTestJson(STREAM);
  test("counts runs/pass/fail", () => {
    expect(s.totalTests).toBe(2);
    expect(s.passed).toBe(1);
    expect(s.failed).toBe(1);
  });
  test("captures the failing test with output excerpt, strips === RUN noise", () => {
    expect(s.failures.length).toBe(1);
    expect(s.failures[0].test).toBe("TestBad");
    expect(s.failures[0].outputExcerpt).toContain("want 1, got 2");
    expect(s.failures[0].outputExcerpt).not.toContain("=== RUN");
    expect(s.packagesWithFailures).toContain("ex/pkg");
  });
  test("ignores non-JSON / blank lines", () => {
    expect(parseGoTestJson("hello\n\nworld").totalTests).toBe(0);
  });
});

describe("go-test-core.renderGoTest", () => {
  test("pass path (exit 0, no failures) -> not an error", () => {
    const s = parseGoTestJson([JSON.stringify({ Action: "run", Package: "p", Test: "T" }), JSON.stringify({ Action: "pass", Package: "p", Test: "T" })].join("\n"));
    const r = renderGoTest(s, { pattern: "./...", cwd: "/repo", exitCode: 0 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("1 passed");
  });
  test("fail path -> error + FAIL block with output", () => {
    const r = renderGoTest(parseGoTestJson(STREAM), { pattern: "./...", cwd: "/repo", exitCode: 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("1 passed, 1 failed");
    expect(r.text).toContain("--- FAIL ex/pkg :: TestBad");
    expect(r.text).toContain("want 1, got 2");
  });
});
