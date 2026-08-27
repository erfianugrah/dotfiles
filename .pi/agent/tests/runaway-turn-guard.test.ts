/**
 * Unit tests for lib/runaway-turn-core.ts.
 *
 * The incident (2026-08-27): a turn ran 9m47s emitting a degenerate stream and
 * the user found out only by cancelling it - "I didn't know till I cancelled it
 * cause it was taking too long". degenerate-stream-guard's repetition matching
 * is a whitelist of known-bad shapes; this guard is the shape-independent
 * backstop, so its tests are mostly about NOT over-firing.
 *
 * Run: ./.pi/agent/tests/run.sh runaway-turn
 */

import { describe, expect, test } from "bun:test";
import {
	abortMessage,
	decide,
	DEFAULT_ABORT_S,
	DEFAULT_MAX_CHARS,
	DEFAULT_WARN_S,
	freshState,
	indicatorText,
	loadConfig,
	type RunawayState,
} from "../extensions/lib/runaway-turn-core.ts";

const T0 = 1_700_000_000_000;

/** A live turn started at T0, with optional overrides. */
function live(over: Partial<RunawayState> = {}): RunawayState {
	return { ...freshState(), startedAt: T0, ...over };
}

const cfg = (over: Partial<ReturnType<typeof loadConfig>> = {}) => ({
	warnS: DEFAULT_WARN_S,
	abortS: DEFAULT_ABORT_S,
	maxChars: DEFAULT_MAX_CHARS,
	...over,
});

describe("defaults (no-false-positive posture)", () => {
	test("hard time abort is OFF by default", () => {
		// The user asked for no false positives; no legitimate-turn ceiling is
		// known well enough to kill on, so time-abort must be opt-in.
		expect(DEFAULT_ABORT_S).toBe(0);
	});

	test("a 10-minute turn warns but does NOT abort under defaults", () => {
		// This is the actual incident duration (9m47s).
		const a = decide(live(), cfg(), T0 + 587_000);
		expect(a.kind).toBe("warn");
	});

	test("idle state does nothing", () => {
		expect(decide(freshState(), cfg(), T0 + 999_000).kind).toBe("none");
	});

	test("a short turn does nothing", () => {
		expect(decide(live(), cfg(), T0 + 5_000).kind).toBe("none");
	});

	test("a legitimate slow turn stays silent until the warn threshold", () => {
		// Measured earlier the same day: a 230k-token prefill at 1302 tok/s is
		// ~3 min of silence before the first token. It must not be killed.
		expect(decide(live(), cfg(), T0 + 119_000).kind).toBe("none");
		expect(decide(live(), cfg(), T0 + 120_000).kind).toBe("warn");
	});
});

describe("volume ceiling (shape-independent catch)", () => {
	test("absurd output volume aborts even with time-abort disabled", () => {
		const a = decide(live({ chars: DEFAULT_MAX_CHARS }), cfg(), T0 + 1_000);
		expect(a.kind).toBe("abort");
		if (a.kind === "abort") expect(a.reason).toContain("volume");
	});

	test("normal answer volume never trips", () => {
		expect(decide(live({ chars: 20_000 }), cfg(), T0 + 10_000).kind).toBe("none");
	});

	test("volume ceiling can be disabled with 0", () => {
		const a = decide(live({ chars: 10_000_000 }), cfg({ maxChars: 0 }), T0 + 1_000);
		expect(a.kind).toBe("none");
	});
});

describe("opt-in time abort", () => {
	test("aborts once past the configured ceiling", () => {
		const a = decide(live(), cfg({ abortS: 300 }), T0 + 300_000);
		expect(a.kind).toBe("abort");
		if (a.kind === "abort") expect(a.reason).toContain("time");
	});

	test("abort takes precedence over warn", () => {
		// A turn blowing past both thresholds must abort, not merely warn.
		expect(decide(live(), cfg({ abortS: 200 }), T0 + 400_000).kind).toBe("abort");
	});

	test("an already-aborted turn is inert (no double abort)", () => {
		const a = decide(live({ aborted: true, chars: 9_000_000 }), cfg({ abortS: 1 }), T0 + 999_000);
		expect(a.kind).toBe("none");
	});
});

describe("loadConfig", () => {
	test("empty env yields the documented defaults", () => {
		expect(loadConfig({})).toEqual({
			warnS: DEFAULT_WARN_S,
			abortS: DEFAULT_ABORT_S,
			maxChars: DEFAULT_MAX_CHARS,
		});
	});

	test("env overrides are honoured", () => {
		const c = loadConfig({
			PI_RUNAWAY_WARN_S: "30",
			PI_RUNAWAY_ABORT_S: "600",
			PI_RUNAWAY_MAX_CHARS: "1000",
		});
		expect(c).toEqual({ warnS: 30, abortS: 600, maxChars: 1000 });
	});

	test("garbage and negatives fall back to defaults", () => {
		const c = loadConfig({ PI_RUNAWAY_WARN_S: "abc", PI_RUNAWAY_ABORT_S: "-5" });
		expect(c.warnS).toBe(DEFAULT_WARN_S);
		expect(c.abortS).toBe(DEFAULT_ABORT_S);
	});

	test("explicit 0 disables a threshold (not treated as unset)", () => {
		expect(loadConfig({ PI_RUNAWAY_WARN_S: "0" }).warnS).toBe(0);
	});
});

describe("message text", () => {
	test("indicator reports minutes, volume and tool calls", () => {
		const a = decide(live({ chars: 42_000, toolCalls: 3 }), cfg(), T0 + 587_000);
		expect(a.kind).toBe("warn");
		if (a.kind !== "warn") return;
		const s = indicatorText(a);
		expect(s).toContain("9m47s"); // the incident duration
		expect(s).toContain("42k chars");
		expect(s).toContain("3 tool calls");
	});

	test("indicator uses seconds under a minute and singular tool call", () => {
		const a = decide(live({ chars: 500, toolCalls: 1 }), cfg({ warnS: 10 }), T0 + 30_000);
		expect(a.kind).toBe("warn");
		if (a.kind !== "warn") return;
		const s = indicatorText(a);
		expect(s).toContain("30s");
		expect(s).toContain("500 chars");
		expect(s).toContain("1 tool call");
	});

	test("abort message names the mechanism and the kill switch", () => {
		const a = decide(live({ chars: DEFAULT_MAX_CHARS }), cfg(), T0 + 1_000);
		expect(a.kind).toBe("abort");
		if (a.kind !== "abort") return;
		const m = abortMessage(a);
		expect(m).toContain("runaway-turn-guard");
		expect(m).toContain("PI_RUNAWAY_GUARD_OFF");
	});
});
