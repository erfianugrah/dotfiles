/**
 * Unit tests for lib/degenerate-core.ts (findPeriodCollapse).
 * Pure helper - runs under the unit suite's preload, no pi runtime needed.
 */

import { describe, expect, test } from "bun:test";
import { findPeriodCollapse, WINDOW } from "../extensions/lib/degenerate-core.ts";

const PROSE =
	"The quick brown fox jumps over the lazy dog. Repetition collapse is a degenerate sampling mode " +
	"where the model emits one token forever. This sentence exists to fill the window with healthy text. ";

describe("findPeriodCollapse", () => {
	test("catches a single-char run (the 2026-08-19 incident)", () => {
		const hit = findPeriodCollapse("!".repeat(400));
		expect(hit).not.toBeNull();
		expect(hit!.period).toBe(1);
		expect(hit!.unit).toBe("!");
	});

	test("catches a two-char dotted-bar cycle", () => {
		const hit = findPeriodCollapse("| ".repeat(200));
		expect(hit).not.toBeNull();
		expect(hit!.period).toBe(2);
	});

	test("catches collapse that starts after healthy prose", () => {
		// tail window must be ~96% periodic: 400 prose chars then 240+ of "!"
		const hit = findPeriodCollapse(PROSE.repeat(4) + "!".repeat(WINDOW));
		expect(hit).not.toBeNull();
		expect(hit!.period).toBe(1);
	});

	test("catches a unicode box-drawing cycle", () => {
		const hit = findPeriodCollapse("╎ ".repeat(150));
		expect(hit).not.toBeNull();
		expect(hit!.period).toBe(2);
	});

	test("ignores healthy prose", () => {
		expect(findPeriodCollapse(PROSE.repeat(4))).toBeNull();
	});

	test("ignores a short burst below the floor", () => {
		expect(findPeriodCollapse("!".repeat(47))).toBeNull();
	});

	test("trips at the 48-char floor", () => {
		expect(findPeriodCollapse("!".repeat(48))).not.toBeNull();
	});

	test("newlines reset the check (multi-line content is healthy)", () => {
		expect(findPeriodCollapse("!\n".repeat(150))).toBeNull();
		const table = Array.from({ length: 30 }, () => "| --- ".repeat(10)).join("\n");
		expect(findPeriodCollapse(table)).toBeNull();
	});

	test("prose tail after a burst is healthy", () => {
		expect(findPeriodCollapse("!".repeat(300) + PROSE)).toBeNull();
	});

	test("near-periodic with sparse noise still trips at >=96%", () => {
		// 240 chars of "!" with 5 scattered flips = 97.5% match
		const chars = "!".repeat(WINDOW).split("");
		for (let i = 0; i < chars.length; i += 48) chars[i] = "?";
		expect(findPeriodCollapse(chars.join(""))).not.toBeNull();
	});

	test("below threshold does not trip", () => {
		// ~92% fidelity with NON-periodic noise: flips at irregular offsets
		// with varied chars, so no period 1..12 reaches 96%.
		const chars = "!".repeat(WINDOW).split("");
		const noise = "?#@%&$";
		let j = 0;
		for (const i of [3, 11, 29, 47, 71, 97, 131, 167, 211, 237]) {
			chars[i] = noise[j++ % noise.length];
		}
		expect(findPeriodCollapse(chars.join(""))).toBeNull();
	});
});
