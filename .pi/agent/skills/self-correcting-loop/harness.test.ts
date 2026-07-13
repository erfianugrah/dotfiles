import { describe, expect, test } from "bun:test";
import {
	type LadderState,
	type SensorResult,
	advanceLadder,
	allPass,
	applyFreeze,
	buildPrompt,
	failingNames,
	countFailing,
	decide,
	detectPreset,
	fingerprint,
	formatFailures,
	globToRegExp,
	matchGlob,
	modelAt,
	normalizeModels,
	outOfScope,
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
		expect(m.models).toEqual([""]);
		expect(m.stallPatience).toBe(2);
		expect(m.baseline).toBe(false);
		expect(m.tools).toEqual(["read", "edit", "write", "bash"]);
		expect(m.writeScope).toEqual([]);
		expect(m.sensors).toHaveLength(1);
	});

	test("normalizes legacy model into models ladder", () => {
		expect(parseManifest({ ...base, model: "sonnet" }).models).toEqual(["sonnet"]);
		expect(parseManifest({ ...base, model: null }).models).toEqual([""]);
	});

	test("accepts a models ladder", () => {
		expect(parseManifest({ ...base, models: ["a", "b"] }).models).toEqual(["a", "b"]);
	});

	test("rejects empty models array", () => {
		expect(() => parseManifest({ ...base, models: [] })).toThrow("models");
	});

	test("rejects non-object / missing task / empty sensors", () => {
		expect(() => parseManifest("nope")).toThrow("must be a JSON object");
		expect(() => parseManifest({ sensors: base.sensors })).toThrow("task");
		expect(() => parseManifest({ ...base, sensors: [] })).toThrow("sensors");
	});

	test("rejects bad stallPatience and writeScope", () => {
		expect(() => parseManifest({ ...base, stallPatience: 0 })).toThrow("stallPatience");
		expect(() => parseManifest({ ...base, writeScope: "x" })).toThrow("writeScope");
	});

	test("accepts baseline flag; rejects non-boolean", () => {
		expect(parseManifest({ ...base, baseline: true }).baseline).toBe(true);
		expect(() => parseManifest({ ...base, baseline: "yes" })).toThrow("baseline");
	});

	test("accepts an optional per-sensor hint; rejects a non-string hint", () => {
		const withHint = parseManifest({
			...base,
			sensors: [{ name: "test", cmd: "go test ./...", hint: "add a table case" }],
		});
		expect(withHint.sensors[0].hint).toBe("add a table case");
		expect(() =>
			parseManifest({ ...base, sensors: [{ name: "t", cmd: "c", hint: 5 }] }),
		).toThrow("sensors[0].hint");
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
});

describe("normalizeModels", () => {
	test("ladder wins over legacy model", () => {
		expect(normalizeModels(["a"], "b")).toEqual(["a"]);
	});
	test("legacy null/undefined -> default rung", () => {
		expect(normalizeModels(undefined, null)).toEqual([""]);
		expect(normalizeModels(undefined, undefined)).toEqual([""]);
	});
});

describe("applyFreeze / failingNames (freeze mode)", () => {
	test("failingNames returns the set of failing sensor names", () => {
		expect([...failingNames([ok("a"), fail("b"), fail("c")])].sort()).toEqual(["b", "c"]);
	});
	test("applyFreeze passes frozen failures, leaves new failures", () => {
		const r = applyFreeze([fail("debt"), fail("new"), ok("x")], new Set(["debt"]));
		expect(r.find((x) => x.name === "debt")?.ok).toBe(true);
		expect(r.find((x) => x.name === "new")?.ok).toBe(false);
		expect(allPass(r)).toBe(false); // a NEW failure still gates
	});
	test("all-frozen failures -> allPass true (nothing new to fix)", () => {
		expect(allPass(applyFreeze([fail("debt"), ok("x")], new Set(["debt"])))).toBe(true);
	});
	test("empty frozen set is a no-op (returns same ref)", () => {
		const input = [fail("a"), ok("b")];
		expect(applyFreeze(input, new Set())).toBe(input);
	});
});

describe("allPass / countFailing / fingerprint", () => {
	test("allPass true only when all ok and non-empty", () => {
		expect(allPass([ok("a"), ok("b")])).toBe(true);
		expect(allPass([ok("a"), fail("b")])).toBe(false);
		expect(allPass([])).toBe(false);
	});
	test("countFailing counts failures", () => {
		expect(countFailing([ok("a"), fail("b"), fail("c")])).toBe(2);
	});
	test("fingerprint is stable and changes with output", () => {
		expect(fingerprint([fail("t", "x")])).toBe(fingerprint([fail("t", "x")]));
		expect(fingerprint([fail("t", "x")])).not.toBe(fingerprint([fail("t", "y")]));
		expect(fingerprint([ok("t")])).toBe("");
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
	});
});

describe("formatFailures / buildPrompt", () => {
	test("formatFailures includes only failures", () => {
		const out = formatFailures([ok("build"), fail("test", "assertion failed")]);
		expect(out).not.toContain("build");
		expect(out).toContain('sensor "test" failed (exit 1)');
		expect(out).toContain("assertion failed");
	});
	test("formatFailures appends a remediation hint when present", () => {
		const out = formatFailures([{ ...fail("lint", "E1"), hint: "run biome check --write" }]);
		expect(out).toContain("how to fix: run biome check --write");
		expect(formatFailures([fail("lint", "E1")])).not.toContain("how to fix");
	});
	test("buildPrompt first iteration is just the task", () => {
		expect(buildPrompt("my task")).toBe("my task");
	});
	test("buildPrompt appends guardrails, notes and feedback", () => {
		const p = buildPrompt("my task", 'sensor "test" failed', [
			"rolled back a regression",
		]);
		expect(p).toContain("my task");
		expect(p).toContain("Do NOT delete, skip, or weaken tests");
		expect(p).toContain("Loop notes");
		expect(p).toContain("rolled back a regression");
		expect(p).toContain('sensor "test" failed');
	});
});

describe("detectPreset", () => {
	test("prefers rust, then go; astro before node; python", () => {
		expect(detectPreset(["Cargo.toml", "go.mod"])).toBe("rust");
		expect(detectPreset(["go.mod"])).toBe("go");
		expect(detectPreset(["package.json", "astro.config.mjs"])).toBe("astro");
		expect(detectPreset(["package.json"])).toBe("node");
		expect(detectPreset(["pyproject.toml"])).toBe("python");
		expect(detectPreset(["README.md"])).toBeNull();
	});
});

describe("globbing / write-scope", () => {
	test("matchGlob handles * and **", () => {
		expect(matchGlob("providers/github/github.go", "providers/github/**")).toBe(true);
		expect(matchGlob("providers/github/github.go", "providers/github/github.go")).toBe(true);
		expect(matchGlob("providers/github/x_test.go", "providers/github/github.go")).toBe(false);
		expect(matchGlob("a/b.go", "**/*.go")).toBe(true);
		expect(matchGlob("conformance/conformance.go", "providers/**")).toBe(false);
	});
	test("globToRegExp escapes regex metachars", () => {
		expect(globToRegExp("a.b").test("a.b")).toBe(true);
		expect(globToRegExp("a.b").test("axb")).toBe(false);
	});
	test("outOfScope returns paths not covered; empty scope = unrestricted", () => {
		const changed = ["providers/github/github.go", "providers/github/github_test.go", "authkit.go"];
		expect(outOfScope(changed, ["providers/github/github.go"])).toEqual([
			"providers/github/github_test.go",
			"authkit.go",
		]);
		expect(outOfScope(changed, [])).toEqual([]);
	});
});

describe("decide", () => {
	test("done when zero failing", () => {
		expect(decide(3, "fp", 0, "").done).toBe(true);
	});
	test("progress when fewer failing", () => {
		const d = decide(3, "a", 1, "b");
		expect(d.progressed).toBe(true);
		expect(d.keep).toBe(true);
	});
	test("lateral move (same count, different fingerprint) counts as progress", () => {
		expect(decide(2, "a", 2, "b").progressed).toBe(true);
	});
	test("stall (same count, same fingerprint) is no progress -> roll back", () => {
		const d = decide(2, "a", 2, "a");
		expect(d.progressed).toBe(false);
		expect(d.keep).toBe(false);
	});
	test("regression (more failing) is no progress", () => {
		expect(decide(1, "a", 3, "c").progressed).toBe(false);
	});
});

describe("advanceLadder / modelAt", () => {
	const start: LadderState = { rung: 0, noProgress: 0 };

	test("progress resets the stall counter", () => {
		const r = advanceLadder({ rung: 1, noProgress: 1 }, true, 2, 3);
		expect(r.state).toEqual({ rung: 1, noProgress: 0 });
		expect(r.escalated).toBe(false);
	});
	test("escalates after patience consecutive stalls", () => {
		let s = start;
		let r = advanceLadder(s, false, 2, 3); // stall 1
		expect(r.escalated).toBe(false);
		expect(r.state).toEqual({ rung: 0, noProgress: 1 });
		r = advanceLadder(r.state, false, 2, 3); // stall 2 -> escalate
		expect(r.escalated).toBe(true);
		expect(r.state).toEqual({ rung: 1, noProgress: 0 });
	});
	test("does not escalate past the top rung", () => {
		const r = advanceLadder({ rung: 2, noProgress: 5 }, false, 2, 3);
		expect(r.escalated).toBe(false);
		expect(r.state.rung).toBe(2);
	});
	test("modelAt clamps to the last rung", () => {
		expect(modelAt(["a", "b"], 0)).toBe("a");
		expect(modelAt(["a", "b"], 5)).toBe("b");
	});
});
