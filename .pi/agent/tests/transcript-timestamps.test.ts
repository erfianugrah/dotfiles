// .pi/agent/tests/transcript-timestamps.test.ts
import { describe, expect, test } from "bun:test";
import {
	IDLE_THRESHOLD_MS,
	fmtClock,
	fmtDayClock,
	fmtElapsed,
	renderRow,
	sameDay,
	type TsRowData,
} from "../extensions/lib/transcript-timestamps-core.ts";

const T = (h: number, m: number, s: number) =>
	new Date(2026, 0, 19, h, m, s).getTime();

describe("fmtClock", () => {
	test("zero-pads H/M/S", () => {
		expect(fmtClock(T(9, 5, 3))).toBe("09:05:03");
	});
	test("23:59:59", () => {
		expect(fmtClock(T(23, 59, 59))).toBe("23:59:59");
	});
});

describe("fmtDayClock", () => {
	test("MM-dd prefix", () => {
		expect(fmtDayClock(new Date(2026, 11, 3, 4, 5, 6).getTime())).toBe(
			"12-03 04:05:06",
		);
	});
});

describe("fmtElapsed", () => {
	test("sub-10s keeps one decimal", () => {
		expect(fmtElapsed(830)).toBe("0.8s");
		expect(fmtElapsed(9_999)).toBe("10.0s");
	});
	test("seconds", () => {
		expect(fmtElapsed(42_000)).toBe("42s");
	});
	test("minutes with zero-padded seconds", () => {
		expect(fmtElapsed(123_000)).toBe("2m 03s");
	});
	test("hours", () => {
		expect(fmtElapsed(3_840_000)).toBe("1h 04m");
	});
	test("days", () => {
		expect(fmtElapsed(2 * 86_400_000 + 5 * 3_600_000)).toBe("2d 5h");
	});
	test("negative / NaN", () => {
		expect(fmtElapsed(-1)).toBe("?");
		expect(fmtElapsed(Number.NaN)).toBe("?");
	});
});

describe("sameDay", () => {
	test("same day true", () => {
		expect(sameDay(T(0, 0, 0), T(23, 59, 59))).toBe(true);
	});
	test("midnight boundary false", () => {
		expect(sameDay(T(23, 59, 59), T(23, 59, 59) + 1_000)).toBe(false);
	});
});

describe("renderRow", () => {
	const user = (over: Partial<TsRowData>): TsRowData => ({
		kind: "user",
		at: T(10, 30, 0),
		...over,
	});
	const turn = (over: Partial<TsRowData>): TsRowData => ({
		kind: "turn",
		at: T(10, 30, 14),
		turnMs: 14_000,
		...over,
	});

	test("user row, no idle under threshold", () => {
		expect(renderRow(user({ idleMs: IDLE_THRESHOLD_MS - 1 }))).toBe(
			"[10:30:00] you",
		);
	});
	test("user row with idle", () => {
		expect(renderRow(user({ idleMs: 192_000 }))).toBe(
			"[10:30:00] you · idle 3m 12s",
		);
	});
	test("turn row shows duration", () => {
		expect(renderRow(turn({}))).toBe("[10:30:14] assistant · 14s");
	});
	test("turn row omits since-prompt when it is the turn itself", () => {
		expect(renderRow(turn({ sincePromptMs: 14_500 }))).toBe(
			"[10:30:14] assistant · 14s",
		);
	});
	test("turn row shows since-prompt on multi-turn runs", () => {
		expect(renderRow(turn({ sincePromptMs: 58_000 }))).toBe(
			"[10:30:14] assistant · 14s · 58s since prompt",
		);
	});
	test("partial marker", () => {
		expect(renderRow(turn({ partial: true }))).toBe(
			"[10:30:14] assistant · 14s · partial",
		);
	});
	test("day-rollover prefix", () => {
		const row = turn({ at: new Date(2026, 0, 20, 0, 0, 5).getTime(), showDate: true });
		expect(renderRow(row)).toBe("[01-20 00:00:05] assistant · 14s");
	});
});
