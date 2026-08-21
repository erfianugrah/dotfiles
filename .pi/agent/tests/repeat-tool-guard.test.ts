// .pi/agent/tests/repeat-tool-guard.test.ts
import { describe, expect, test } from "bun:test";
import {
	canonicalize,
	parseThresholds,
	reminderFor,
	track,
	type Chain,
	type ChainConfig,
} from "../extensions/lib/repeat-tool-core.ts";

const CFG: ChainConfig = {
	thresholds: [3, 5, 8],
	exclude: new Set(["todowrite"]),
	argumentsPreviewChars: 50,
};

function freshChain(): Chain {
	return { lastKey: null, count: 0 };
}

describe("canonicalize", () => {
	test("key order does not matter", () => {
		expect(canonicalize({ a: 1, b: { c: 2, d: 3 } })).toBe(
			canonicalize({ b: { d: 3, c: 2 }, a: 1 }),
		);
	});
	test("distinguishes different values", () => {
		expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: 2 }));
	});
});

describe("track", () => {
	test("consecutive identical calls increment", () => {
		const c = freshChain();
		expect(track(c, "grep", { pattern: "x" }, CFG)).toBe(1);
		expect(track(c, "grep", { pattern: "x" }, CFG)).toBe(2);
		expect(track(c, "grep", { pattern: "x" }, CFG)).toBe(3);
	});
	test("a different call resets to 1", () => {
		const c = freshChain();
		track(c, "grep", { pattern: "x" }, CFG);
		track(c, "grep", { pattern: "x" }, CFG);
		expect(track(c, "grep", { pattern: "y" }, CFG)).toBe(1);
	});
	test("same args on a different tool is a different chain key", () => {
		const c = freshChain();
		track(c, "grep", { pattern: "x" }, CFG);
		expect(track(c, "rg", { pattern: "x" }, CFG)).toBe(1);
	});
	test("excluded tools are transparent - no increment, no reset", () => {
		const c = freshChain();
		track(c, "grep", { pattern: "x" }, CFG);
		track(c, "grep", { pattern: "x" }, CFG);
		expect(track(c, "todowrite", { todos: [] }, CFG)).toBe("transparent");
		expect(track(c, "grep", { pattern: "x" }, CFG)).toBe(3);
	});
});

describe("reminderFor", () => {
	test("null below and between thresholds", () => {
		expect(reminderFor("grep", { pattern: "x" }, 2, CFG)).toBeNull();
		expect(reminderFor("grep", { pattern: "x" }, 4, CFG)).toBeNull();
	});
	test("first threshold is the short nudge", () => {
		const r = reminderFor("grep", { pattern: "x" }, 3, CFG)!;
		expect(r).toContain("repeating the exact same tool call");
		expect(r).not.toContain("consecutive_calls");
	});
	test("later thresholds are detailed and name the tool and count", () => {
		const r = reminderFor("grep", { pattern: "x" }, 5, CFG)!;
		expect(r).toContain("tool: grep");
		expect(r).toContain("consecutive_calls: 5");
		expect(r).toContain("arguments:");
	});
	test("argument preview is capped with an omitted-count marker", () => {
		const long = { pattern: "z".repeat(500) };
		const r = reminderFor("grep", long, 5, CFG)!;
		expect(r).toContain("(+");
		expect(r).toContain("more chars)");
		expect(r!.length).toBeLessThan(600);
	});
});

describe("parseThresholds", () => {
	test("parses and sorts", () => {
		expect(parseThresholds("8,3,5")).toEqual([3, 5, 8]);
	});
	test("rejects duplicates, values < 2, and non-integers", () => {
		expect(() => parseThresholds("3,3")).toThrow();
		expect(() => parseThresholds("1,3")).toThrow();
		expect(() => parseThresholds("3,abc")).toThrow();
		expect(() => parseThresholds("")).toThrow();
	});
});
