/**
 * Unit tests for the pure helpers in session-auto-title.ts.
 *
 * The retry semantics are the point: failure markers (including the legacy
 * pre-retry `skipped: "no-model" | "empty-response"` and `{error}` shapes)
 * must count as retryable attempts, while a success title or a manual-name
 * skip is terminal.
 *
 * Run: ./.pi/agent/tests/run.sh session-auto-title
 */

import { describe, expect, test } from "bun:test";

import { cleanTitle, markerState, type MarkerData } from "../extensions/session-auto-title.ts";

describe("cleanTitle", () => {
  test("strips quotes and Title: prefix", () => {
    expect(cleanTitle('"Title: Fix the router"')).toBe("Fix the router");
  });
  test("collapses whitespace and takes first line", () => {
    expect(cleanTitle("  Foo   bar baz\nSome explanation follows")).toBe("Foo bar baz");
  });
  test("caps at 8 words", () => {
    expect(cleanTitle("one two three four five six seven eight nine ten")).toBe(
      "one two three four five six seven eight",
    );
  });
  test("drops trailing period", () => {
    expect(cleanTitle("Deploy the stack.")).toBe("Deploy the stack");
  });
  test("empty-ish input stays empty", () => {
    expect(cleanTitle("   \n  ")).toBe("");
  });
});

describe("markerState", () => {
  test("no markers -> retryable with zero attempts", () => {
    expect(markerState([])).toEqual({ kind: "retry", attempts: 0 });
  });
  test("success marker is terminal", () => {
    const markers: MarkerData[] = [{ title: "Foo", attempts: 1 }];
    expect(markerState(markers)).toEqual({ kind: "done" });
  });
  test("manual-name skip is terminal", () => {
    const markers: MarkerData[] = [{ skipped: "manual-name-set" }];
    expect(markerState(markers)).toEqual({ kind: "done" });
  });
  test("new-style failure markers count as retryable attempts", () => {
    const markers: MarkerData[] = [
      { failed: true, reason: "empty-response", attempts: 1 },
      { failed: true, reason: "no-model", attempts: 2 },
    ];
    expect(markerState(markers)).toEqual({ kind: "retry", attempts: 2 });
  });
  test("legacy tombstones (no-model / empty-response / error) are retryable", () => {
    expect(markerState([{ skipped: "no-model" }])).toEqual({ kind: "retry", attempts: 1 });
    expect(markerState([{ skipped: "empty-response" }])).toEqual({ kind: "retry", attempts: 1 });
    expect(markerState([{ error: "boom" }])).toEqual({ kind: "retry", attempts: 1 });
  });
  test("a success after failures is terminal", () => {
    const markers: MarkerData[] = [
      { failed: true, reason: "empty-response", attempts: 1 },
      { title: "Finally named" },
    ];
    expect(markerState(markers)).toEqual({ kind: "done" });
  });
});
