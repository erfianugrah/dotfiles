/**
 * Unit tests for lib/degenerate-core.ts (findPeriodCollapse).
 * Pure helper - runs under the unit suite's preload, no pi runtime needed.
 */

import { describe, expect, test } from "bun:test";
import {
	findCollapse,
	findLineCollapse,
	findPeriodCollapse,
	WINDOW,
} from "../extensions/lib/degenerate-core.ts";

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

	// NOTE: findPeriodCollapse deliberately bails on any newline in the tail
	// (protects wide markdown tables). That blindness is what let the
	// 2026-08-27 incident run for ~10 minutes; findLineCollapse covers it, so
	// this test documents the char-detector's scope, NOT desired end behaviour.
	test("char detector ignores newline-separated input (by design; see findLineCollapse)", () => {
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

// ---------------------------------------------------------------------------
// findLineCollapse / findCollapse - the 2026-08-27 incident.
//
// kimi-k3 streamed "   <U+FFFD>" + a blank line for ~10 minutes, twice, and
// findPeriodCollapse never fired: its `tail.includes("\n")` bail-out makes it
// blind to every newline-separated loop. The user only noticed because the
// turn felt slow and they cancelled it.
//
// The false-positive bar is the design constraint here (user: "how do I
// prevent this also without false positives"), so the rule is deliberately
// severe: an EXACT byte-identical cycle of a short unit, 30+ consecutive
// repeats. Legitimate generated output varies line to line well before that.
// ---------------------------------------------------------------------------

const REPL = String.fromCharCode(0xfffd);
/** The observed stream: three spaces, replacement char, blank line. */
const USER_LOOP = ("   " + REPL + "\n\n").repeat(200);

describe("findLineCollapse (2026-08-27 newline-separated collapse)", () => {
	test("catches the exact incident stream that the char detector missed", () => {
		expect(findPeriodCollapse(USER_LOOP)).toBeNull(); // the miss, still true
		const hit = findLineCollapse(USER_LOOP);
		expect(hit).not.toBeNull();
		expect(hit!.period).toBe(2); // content line + blank line
	});

	test("catches an identical-line run", () => {
		const hit = findLineCollapse("thinking...\n".repeat(40));
		expect(hit).not.toBeNull();
		expect(hit!.period).toBe(1);
	});

	test("catches a multi-line cycle", () => {
		const hit = findLineCollapse("a\nb\nc\n".repeat(40));
		expect(hit).not.toBeNull();
		expect(hit!.period).toBe(3);
	});

	test("catches endless blank lines", () => {
		expect(findLineCollapse("\n".repeat(60))).not.toBeNull();
	});

	test("ignores a run below the 30-repeat floor", () => {
		expect(findLineCollapse("same\n".repeat(29))).toBeNull();
	});

	test("ignores a partial trailing line breaking an otherwise exact cycle", () => {
		// Mid-stream the last line is incomplete; it must not defeat detection.
		expect(findLineCollapse("dup\n".repeat(40) + "dup-partial")).not.toBeNull();
	});

	test("no false positive on real multi-line content", () => {
		const cases: Array<[string, string]> = [
			["markdown table", Array.from({ length: 30 }, (_, i) => `| row${i} | v${i} |`).join("\n")],
			["numbered list", Array.from({ length: 40 }, (_, i) => `${i}. item ${i}`).join("\n")],
			["ls output", Array.from({ length: 40 }, (_, i) => `file-${i}.ts`).join("\n")],
			["diff hunk", Array.from({ length: 40 }, (_, i) => `+  const x${i} = ${i};`).join("\n")],
			["yaml list", Array.from({ length: 30 }, (_, i) => `  - name: svc${i}`).join("\n")],
			["uniform log lines", Array.from({ length: 40 }, (_, i) => `INFO request ${i} ok`).join("\n")],
			["prose paragraphs", Array.from({ length: 25 }, (_, i) => `Paragraph ${i} says a thing.\n`).join("\n")],
			// 25 identical closing braces from a code generator: plausible real
			// output, and under the floor. This is the case that forced the
			// 12 -> 30 repeat bump.
			["25 identical braces", Array.from({ length: 25 }, () => "  }").join("\n") + "\nx"],
		];
		for (const [name, text] of cases) {
			expect(findLineCollapse(text), `false positive on ${name}`).toBeNull();
		}
	});
});

describe("findCollapse (both modes)", () => {
	test("covers the char mode (2026-08-19)", () => {
		expect(findCollapse("!".repeat(400))).not.toBeNull();
	});
	test("covers the line mode (2026-08-27)", () => {
		expect(findCollapse(USER_LOOP)).not.toBeNull();
	});
	test("healthy prose stays healthy in both modes", () => {
		expect(findCollapse(PROSE.repeat(4))).toBeNull();
	});
});
