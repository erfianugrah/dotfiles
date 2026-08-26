/**
 * trigger-compact: the small-context-window gate.
 *
 * Regression origin (2026-08-26): auto-compact fired on a model whose context
 * window was smaller than pi's `compaction.keepRecentTokens`, so the entire
 * branch sat inside the kept tail. pi's prepareCompaction() returns undefined
 * in that case and compact() throws "Nothing to compact (session too small)" -
 * the user saw "compaction started" followed by three stacked failures. The
 * llm-compose `erfi` preset (context_size 8192) hits this every time.
 */
import { expect, test } from "bun:test";
import { canCompact } from "../extensions/trigger-compact.ts";

const FRACTION = 0.85;
const at = (ctx: number) => Math.floor(ctx * FRACTION);
const KEEP = 20000; // pi's default compaction.keepRecentTokens

test("8192-token window (llm-compose erfi preset) is refused - the observed failure", () => {
  // threshold 6963 is BELOW keepRecentTokens: nothing is summarisable.
  expect(canCompact(at(8192), KEEP)).toBe(false);
});

test("window just above keepRecentTokens is still refused (margin too thin)", () => {
  // 24000 * 0.85 = 20400, only 400 tokens over the tail.
  expect(canCompact(at(24000), KEEP)).toBe(false);
});

test("32768-token window is allowed (7852 tokens summarisable)", () => {
  expect(canCompact(at(32768), KEEP)).toBe(true);
});

test("large windows are unaffected", () => {
  expect(canCompact(at(196608), KEEP)).toBe(true);
  expect(canCompact(at(131072), KEEP)).toBe(true);
});

test("boundary: exactly MIN_SUMMARISABLE_TOKENS of margin is allowed", () => {
  expect(canCompact(21000, KEEP)).toBe(true);
  expect(canCompact(20999, KEEP)).toBe(false);
});

test("lowering keepRecentTokens rescues a small window", () => {
  // The documented escape hatch: shrink the kept tail instead of the model.
  expect(canCompact(at(8192), 4000)).toBe(true);
});
