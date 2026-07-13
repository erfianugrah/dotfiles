import { describe, expect, test } from "bun:test";
import {
	type SensorResult,
	allPass,
	buildPrompt,
	detectPreset,
	formatFailures,
	parseManifest,
	truncate,
} from "./harness.ts";

const ok = (name: string): SensorResult => ({
	name,
	cmd: `run ${name}`,
	ok: true,
	exitCode: 0,
	output: "",
});
const fail = (name: string, output = "boom"): SensorResult => ({
	name,
	cmd: `run ${name}`,
	ok: false,
	exitCode: 1,
	output,
});

describe("parseManifest", () => {
	const base = {
		task: "do the thing",
		sensors: [{ name: "test", cmd: "go test ./..." }],
	};

	test("accepts a minimal manifest and applies defaults", () => {
		const m = parseManifest(base);
		expect(m.task).toBe("do the thing");
		expect(m.maxIterations).toBe(10);
		expect(m.model).toBeNull();
		expect(m.tools).toEqual(["read", "edit", "write", "bash"]);
		expect(m.sensors).toHaveLength(1);
	});

	test("rejects non-object", () => {
		expect(() => parseManifest("nope")).toThrow("must be a JSON object");
		expect(() => parseManifest(null)).toThrow("must be a JSON object");
		expect(() => parseManifest([])).toThrow("must be a JSON object");
	});

	test("requires non-empty task", () => {
		expect(() => parseManifest({ ...base, task: "" })).toThrow("task");
		expect(() => parseManifest({ sensors: base.sensors })).toThrow("task");
	});

	test("requires positive integer maxIterations", () => {
		expect(() => parseManifest({ ...base, maxIterations: 0 })).toThrow(
			"maxIterations",
		);
		expect(() => parseManifest({ ...base, maxIterations: 1.5 })).toThrow(
			"maxIterations",
		);
	});

	test("requires non-empty sensors array", () => {
		expect(() => parseManifest({ ...base, sensors: [] })).toThrow("sensors");
		expect(() => parseManifest({ task: "x" })).toThrow("sensors");
	});

	test("rejects sensor missing name or cmd", () => {
		expect(() =>
			parseManifest({ ...base, sensors: [{ cmd: "x" }] }),
		).toThrow("sensors[0].name");
		expect(() =>
			parseManifest({ ...base, sensors: [{ name: "x" }] }),
		).toThrow("sensors[0].cmd");
	});

	test("rejects duplicate sensor names", () => {
		expect(() =>
			parseManifest({
				...base,
				sensors: [
					{ name: "t", cmd: "a" },
					{ name: "t", cmd: "b" },
				],
			}),
		).toThrow('duplicate name "t"');
	});

	test("rejects non-string model", () => {
		expect(() => parseManifest({ ...base, model: 42 })).toThrow("model");
	});
});

describe("allPass", () => {
	test("true only when all ok and non-empty", () => {
		expect(allPass([ok("a"), ok("b")])).toBe(true);
		expect(allPass([ok("a"), fail("b")])).toBe(false);
		expect(allPass([])).toBe(false);
	});
});

describe("truncate", () => {
	test("passes short strings through", () => {
		expect(truncate("hello", 100)).toBe("hello");
	});
	test("keeps head and tail of long strings", () => {
		const s = "A".repeat(50) + "B".repeat(50);
		const out = truncate(s, 40);
		expect(out).toContain("truncated");
		expect(out.startsWith("A")).toBe(true);
		expect(out.endsWith("B")).toBe(true);
		expect(out.length).toBeLessThan(s.length);
	});
});

describe("formatFailures", () => {
	test("includes only failures with cmd and output", () => {
		const out = formatFailures([ok("build"), fail("test", "assertion failed")]);
		expect(out).not.toContain("build");
		expect(out).toContain('sensor "test" failed (exit 1)');
		expect(out).toContain("assertion failed");
	});
	test("empty when nothing failed", () => {
		expect(formatFailures([ok("a")])).toBe("");
	});
});

describe("buildPrompt", () => {
	test("first iteration is just the task", () => {
		expect(buildPrompt("my task")).toBe("my task");
	});
	test("later iterations append guardrails and feedback", () => {
		const p = buildPrompt("my task", 'sensor "test" failed');
		expect(p).toContain("my task");
		expect(p).toContain("Automated checks failed");
		expect(p).toContain("Do NOT delete, skip, or weaken tests");
		expect(p).toContain('sensor "test" failed');
	});
});

describe("detectPreset", () => {
	test("prefers rust, then go", () => {
		expect(detectPreset(["Cargo.toml", "go.mod"])).toBe("rust");
		expect(detectPreset(["go.mod"])).toBe("go");
	});
	test("astro before node when astro.config present", () => {
		expect(detectPreset(["package.json", "astro.config.mjs"])).toBe("astro");
		expect(detectPreset(["package.json"])).toBe("node");
	});
	test("python via pyproject or requirements", () => {
		expect(detectPreset(["pyproject.toml"])).toBe("python");
		expect(detectPreset(["requirements.txt"])).toBe("python");
	});
	test("null when nothing recognized", () => {
		expect(detectPreset(["README.md"])).toBeNull();
	});
});
