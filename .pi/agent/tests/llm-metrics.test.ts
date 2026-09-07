import { describe, expect, test } from "bun:test";
import {
	fmtK,
	fmtNum,
	parseEngineLine,
	percentile,
	summarize,
	summarizeEngineLog,
	type ReqStat,
} from "../extensions/lib/llm-metrics-core.ts";

describe("percentile", () => {
	test("empty -> NaN", () => {
		expect(percentile([], 0.5)).toBeNaN();
	});
	test("single value", () => {
		expect(percentile([42], 0.5)).toBe(42);
		expect(percentile([42], 0.05)).toBe(42);
	});
	test("nearest-rank on sorted set", () => {
		const v = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
		expect(percentile(v, 0)).toBe(10);
		expect(percentile(v, 0.5)).toBe(60);
		expect(percentile(v, 0.95)).toBe(100);
	});
	test("sorts unsorted input", () => {
		expect(percentile([100, 10, 50], 0.5)).toBe(50);
	});
});

const ENGINE_LINE =
	"2026-09-07 13:01:37.775  INFO  req#1 done | openai-chat | stop token | prompt 23 | output 33 | cache 0 (0.0%) | TTFT 70.9 ms | total 239 ms | prefill 325.7 tok/s | decode 190.7 tok/s | mtp accepted 23/30 (76.7%)";

describe("parseEngineLine", () => {
	test("parses a req-done line", () => {
		const p = parseEngineLine(ENGINE_LINE);
		expect(p).not.toBeNull();
		expect(p!.decode).toBeCloseTo(190.7);
		expect(p!.mtpAccepted).toBe(23);
		expect(p!.mtpTotal).toBe(30);
		expect(p!.mtpPct).toBeCloseTo(76.7);
	});
	test("rejects non-matching lines", () => {
		expect(parseEngineLine("2026-09-07 INFO starting up")).toBeNull();
		expect(parseEngineLine("")).toBeNull();
	});
});

describe("summarizeEngineLog", () => {
	test("aggregates mtp + counts errors", () => {
		const log = [
			ENGINE_LINE,
			ENGINE_LINE.replace("76.7", "54.0").replace("23/30", "16/30"),
			"2026-09-07 13:02:00 ERROR something broke",
			"noise line",
		].join("\n");
		const s = summarizeEngineLog(log);
		expect(s.requests).toBe(2);
		expect(s.mtpPctMedian).toBeCloseTo(76.7); // nearest-rank p50 of [54, 76.7]
		expect(s.errors).toBe(1);
	});
	test("no req lines -> NaN median, zero requests", () => {
		const s = summarizeEngineLog("ERROR x\nINFO y");
		expect(s.requests).toBe(0);
		expect(s.mtpPctMedian).toBeNaN();
		expect(s.errors).toBe(1);
	});
});

describe("summarize", () => {
	const mk = (over: Partial<ReqStat>): ReqStat => ({
		ts: 0,
		prompt: 1000,
		output: 100,
		cacheHit: 0.5,
		ttftMs: 200,
		decodeTokS: 120,
		provider: "llama-server",
		modelId: "qwen38",
		...over,
	});

	test("aggregates rows", () => {
		const s = summarize([
			mk({ decodeTokS: 100 }),
			mk({ decodeTokS: 120 }),
			mk({ decodeTokS: 90, prompt: 5000 }),
			mk({ decodeTokS: 160, prompt: 110902, cacheHit: 0.997 }),
		]);
		expect(s.n).toBe(4);
		expect(s.below100).toBe(1);
		expect(s.ctxMax).toBe(110902);
		expect(s.ctxP50).toBe(5000); // nearest-rank p50 of [1000,1000,5000,110902]
		expect(s.decP50).toBe(120);
	});
	test("empty -> zeros/NaN", () => {
		const s = summarize([]);
		expect(s.n).toBe(0);
		expect(s.decP50).toBeNaN();
		expect(s.ctxMax).toBe(0);
	});
});

describe("fmt helpers", () => {
	test("fmtK", () => {
		expect(fmtK(999)).toBe("999");
		expect(fmtK(84_000)).toBe("84K");
	});
	test("fmtNum", () => {
		expect(fmtNum(110902)).toBe("110,902");
	});
});
