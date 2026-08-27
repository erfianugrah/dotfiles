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

import {
  cleanTitle,
  markerState,
  pickTitleCandidates,
  type MarkerData,
} from "../extensions/session-auto-title.ts";

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

// Regression cover for the 2026-08-26 `reason:"no-model"` bug: candidate
// discovery used to enumerate models.json and resolve each entry through
// pi-ai's getModel(), which returns undefined for CUSTOM providers. Every
// llama-server model was dropped, models.json listed 0 openrouter models,
// so the list came back EMPTY and 627 sessions in 2026-08 went untitled.
// Discovery now goes through ctx.modelRegistry.getAvailable().
describe("pickTitleCandidates", () => {
  const fakeCtx = (available: Array<{ id: string; provider: string }>, model?: unknown) =>
    ({ model, modelRegistry: { getAvailable: async () => available } }) as never;

  test("returns custom-provider models (the getModel-undefined bug)", async () => {
    const got = await pickTitleCandidates(
      fakeCtx([{ id: "qwen38", provider: "llama-server" }]),
    );
    expect(got.length).toBeGreaterThan(0);
    expect(got[0].model.id).toBe("qwen38");
  });

  test("current session model is tried first", async () => {
    const got = await pickTitleCandidates(
      fakeCtx(
        [
          { id: "claude-haiku-4-5", provider: "anthropic" },
          { id: "z-ai/glm-5.3", provider: "openrouter" },
        ],
        { id: "z-ai/glm-5.3", provider: "openrouter" },
      ),
    );
    expect(got[0].model.id).toBe("z-ai/glm-5.3");
  });

  test("falls back to ctx.model even when getAvailable is empty", async () => {
    const got = await pickTitleCandidates(
      fakeCtx([], { id: "qwen38", provider: "llama-server" }),
    );
    expect(got.length).toBe(1);
    expect(got[0].model.id).toBe("qwen38");
  });

  test("local models outrank cloud in the fallback ordering", async () => {
    const got = await pickTitleCandidates(
      fakeCtx([
        { id: "anthropic.claude-opus-5", provider: "amazon-bedrock" },
        { id: "summarizer", provider: "llama-server" },
      ]),
    );
    expect(got[0].model.id).toBe("summarizer");
  });

  test("survives a getAvailable that throws", async () => {
    const ctx = {
      model: { id: "qwen38", provider: "llama-server" },
      modelRegistry: {
        getAvailable: async () => {
          throw new Error("registry down");
        },
      },
    } as never;
    const got = await pickTitleCandidates(ctx);
    expect(got.length).toBe(1);
  });

  test("no model anywhere -> empty (the only legitimate no-model case)", async () => {
    expect(await pickTitleCandidates(fakeCtx([]))).toEqual([]);
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
