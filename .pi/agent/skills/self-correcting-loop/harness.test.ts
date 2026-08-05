import { describe, expect, test } from "bun:test";
import {
	type LadderState,
	type SensorResult,
	advanceLadder,
	allPass,
	applyFreeze,
	DEFAULT_AGENT_TIMEOUT_MS,
	DEFAULT_SENSOR_TIMEOUT_MS,
	buildPrompt,
	failingNames,
	countFailing,
	decide,
	detectPreset,
	fingerprint,
	type AttemptRecord,
	formatAttemptHistory,
	formatCanaryReport,
	formatFailures,
	formatReport,
	blockedBy,
	isCanaryFailure,
	judgeCanary,
	globToRegExp,
	limitsArgs,
	matchGlob,
	modelAt,
	falsePremises,
	gatingSensors,
	nonDiscriminating,
	normalizeModels,
	outOfScope,
	parseLimits,
	parseManifest,
	stuckSensors,
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

	test("accepts sandbox mode; rejects bogus values", () => {
		expect(parseManifest(base).sandbox).toBe("auto");
		expect(parseManifest({ ...base, sandbox: "require" }).sandbox).toBe("require");
		expect(parseManifest({ ...base, sandbox: "off" }).sandbox).toBe("off");
		expect(() => parseManifest({ ...base, sandbox: "bogus" })).toThrow("sandbox");
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
	test("buildPrompt iteration 1 carries the task AND the standing guardrails", () => {
		// Regression: these used to appear only in the failure-feedback block,
		// so a one-shot task got NO guardrails. An A/B of the anti-stub rule
		// came back null purely because every run converged in one iteration
		// and the rule was never in the prompt.
		const p = buildPrompt("my task");
		expect(p).toContain("my task");
		expect(p).toContain("Do NOT stub");
		expect(p).toContain("weaken tests");
		expect(p).toContain("Do NOT run git commit");
		// ...but NOT the feedback-scoped ones, which need failures to make sense
		expect(p).not.toContain("smallest change");
		expect(p).not.toContain("Automated checks failed");
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
	test("buildPrompt includes attempt-history section when provided", () => {
		const p = buildPrompt("my task", 'sensor "test" failed', [], "- iteration 2: touched a.ts");
		expect(p).toContain("Previous approaches that were rolled back");
		expect(p).toContain("- iteration 2: touched a.ts");
	});
	test("buildPrompt omits attempt-history section when empty", () => {
		const p = buildPrompt("my task", 'sensor "test" failed');
		expect(p).not.toContain("Previous approaches");
	});
});

describe("formatAttemptHistory", () => {
	const attempt = (over: Partial<AttemptRecord>): AttemptRecord => ({
		iteration: 1,
		kept: false,
		changedFiles: ["src/foo.ts"],
		failingBefore: 3,
		failingAfter: 3,
		...over,
	});

	test("empty when there are no rolled-back attempts", () => {
		expect(formatAttemptHistory([])).toBe("");
		expect(formatAttemptHistory([attempt({ kept: true })])).toBe("");
		expect(formatAttemptHistory([attempt({ changedFiles: [] })])).toBe("");
	});

	test("lists only rolled-back attempts with files and sensor delta", () => {
		const out = formatAttemptHistory([
			attempt({ iteration: 1, kept: true, changedFiles: ["kept.ts"] }),
			attempt({ iteration: 2, changedFiles: ["src/a.ts", "src/b.ts"], failingBefore: 3, failingAfter: 4 }),
		]);
		expect(out).not.toContain("kept.ts");
		expect(out).toContain("iteration 2");
		expect(out).toContain("src/a.ts, src/b.ts");
		expect(out).toContain("failing 3 -> 4");
	});

	test("caps at max most recent rolled-back attempts and notes overflow", () => {
		const attempts = Array.from({ length: 7 }, (_, i) =>
			attempt({ iteration: i + 1, changedFiles: [`f${i + 1}.ts`] }),
		);
		const out = formatAttemptHistory(attempts, 3);
		expect(out).toContain("f5.ts");
		expect(out).toContain("f7.ts");
		expect(out).not.toContain("f4.ts");
		expect(out).toContain("4 earlier");
	});

	test("truncates long file lists", () => {
		const out = formatAttemptHistory([
			attempt({ changedFiles: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"] }),
		]);
		expect(out).toContain("a.ts");
		expect(out).toContain("+2 more");
		expect(out).not.toContain("e.ts");
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

describe("nonDiscriminating", () => {
	const res = (name: string, ok: boolean) => ({
		name, cmd: "x", ok, exitCode: ok ? 0 : 1, output: "",
	});

	test("flags a feature sensor that passes at baseline", () => {
		const sensors = [
			{ name: "build", cmd: "b" },
			{ name: "feature-x", cmd: "f", expect: "fail" as const },
		];
		expect(nonDiscriminating(sensors, [res("build", true), res("feature-x", true)]))
			.toEqual(["feature-x"]);
	});

	test("a feature sensor that fails at baseline is correct", () => {
		const sensors = [{ name: "feature-x", cmd: "f", expect: "fail" as const }];
		expect(nonDiscriminating(sensors, [res("feature-x", false)])).toEqual([]);
	});

	test("guards default to expect pass and are never flagged", () => {
		const sensors = [{ name: "build", cmd: "b" }, { name: "vet", cmd: "v", expect: "pass" as const }];
		expect(nonDiscriminating(sensors, [res("build", true), res("vet", true)])).toEqual([]);
	});

	test("reports every offender, not just the first", () => {
		const sensors = [
			{ name: "a", cmd: "a", expect: "fail" as const },
			{ name: "b", cmd: "b", expect: "fail" as const },
			{ name: "c", cmd: "c", expect: "fail" as const },
		];
		const baseline = [res("a", true), res("b", false), res("c", true)];
		expect(nonDiscriminating(sensors, baseline)).toEqual(["a", "c"]);
	});

	test("a missing baseline result is not flagged", () => {
		const sensors = [{ name: "ghost", cmd: "g", expect: "fail" as const }];
		expect(nonDiscriminating(sensors, [])).toEqual([]);
	});
});

describe("falsePremises", () => {
	const res = (name: string, ok: boolean) => ({
		name, cmd: "x", ok, exitCode: ok ? 0 : 1, output: "",
	});

	test("flags a premise that fails at baseline", () => {
		// The case that produced this: a task to unify "the four primitives these
		// two guides share" against a second guide that shared none of them.
		const sensors = [
			{ name: "build", cmd: "b" },
			{ name: "premise-shared-primitives", cmd: "p", kind: "premise" as const },
		];
		expect(falsePremises(sensors, [res("build", true), res("premise-shared-primitives", false)]))
			.toEqual(["premise-shared-primitives"]);
	});

	test("a premise that holds is not flagged", () => {
		const sensors = [{ name: "p", cmd: "p", kind: "premise" as const }];
		expect(falsePremises(sensors, [res("p", true)])).toEqual([]);
	});

	test("a failing GUARD is not a false premise - it is the work", () => {
		// The asymmetry is the whole point: red guard = fix the tree, red premise =
		// fix the spec. Conflating them is how the false claim gets invented.
		const sensors = [{ name: "build", cmd: "b" }, { name: "feat", cmd: "f", expect: "fail" as const }];
		expect(falsePremises(sensors, [res("build", false), res("feat", false)])).toEqual([]);
	});

	test("reports every offender, not just the first", () => {
		const sensors = [
			{ name: "a", cmd: "a", kind: "premise" as const },
			{ name: "b", cmd: "b", kind: "premise" as const },
			{ name: "c", cmd: "c", kind: "premise" as const },
		];
		expect(falsePremises(sensors, [res("a", false), res("b", true), res("c", false)]))
			.toEqual(["a", "c"]);
	});

	test("a missing baseline result is not flagged", () => {
		const sensors = [{ name: "ghost", cmd: "g", kind: "premise" as const }];
		expect(falsePremises(sensors, [])).toEqual([]);
	});

	test("gatingSensors drops premises and keeps everything else", () => {
		const sensors = [
			{ name: "build", cmd: "b" },
			{ name: "p", cmd: "p", kind: "premise" as const },
			{ name: "feat", cmd: "f", kind: "sensor" as const, expect: "fail" as const },
		];
		expect(gatingSensors(sensors).map((s) => s.name)).toEqual(["build", "feat"]);
	});
});

describe("manifest kind field", () => {
	test("parses premise and defaults to undefined", () => {
		const m = parseManifest({
			task: "t",
			sensors: [
				{ name: "a", cmd: "a" },
				{ name: "b", cmd: "b", kind: "premise" },
				{ name: "c", cmd: "c", kind: "sensor" },
			],
		});
		expect(m.sensors.map((s) => s.kind)).toEqual([undefined, "premise", "sensor"]);
	});

	test("rejects a bogus kind value", () => {
		expect(() =>
			parseManifest({ task: "t", sensors: [{ name: "a", cmd: "a", kind: "guard" }] }),
		).toThrow(/kind must be/);
	});

	test("rejects a premise that declares expect", () => {
		// kind: "premise" + expect: "fail" would assert the spec rests on something
		// known to be false.
		expect(() =>
			parseManifest({ task: "t", sensors: [{ name: "a", cmd: "a", kind: "premise", expect: "fail" }] }),
		).toThrow(/premise cannot declare expect/);
	});

	test("rejects a premise that declares a canary", () => {
		expect(() =>
			parseManifest({ task: "t", sensors: [{ name: "a", cmd: "a", kind: "premise", canary: "x" }] }),
		).toThrow(/premise cannot declare a canary/);
	});
});

describe("manifest expect field", () => {
	test("parses pass/fail and defaults to undefined", () => {
		const m = parseManifest({
			task: "t",
			sensors: [
				{ name: "a", cmd: "a" },
				{ name: "b", cmd: "b", expect: "fail" },
				{ name: "c", cmd: "c", expect: "pass" },
			],
		});
		expect(m.sensors.map((s) => s.expect)).toEqual([undefined, "fail", "pass"]);
	});

	test("rejects a bogus expect value", () => {
		expect(() =>
			parseManifest({ task: "t", sensors: [{ name: "a", cmd: "a", expect: "maybe" }] }),
		).toThrow(/expect must be/);
	});
});

describe("timeout budgets", () => {
	test("manifest defaults sensor + agent budgets", () => {
		const m = parseManifest({ task: "t", sensors: [{ name: "a", cmd: "a" }] });
		expect(m.timeoutMs).toBe(DEFAULT_SENSOR_TIMEOUT_MS);
		expect(m.agentTimeoutMs).toBe(DEFAULT_AGENT_TIMEOUT_MS);
		expect(m.sensors[0].timeoutMs).toBeUndefined();
	});

	test("per-sensor timeoutMs overrides the manifest default", () => {
		const m = parseManifest({
			task: "t",
			timeoutMs: 5000,
			agentTimeoutMs: 9000,
			sensors: [
				{ name: "fast", cmd: "a" },
				{ name: "slow", cmd: "b", timeoutMs: 60000 },
			],
		});
		expect(m.timeoutMs).toBe(5000);
		expect(m.agentTimeoutMs).toBe(9000);
		expect(m.sensors[1].timeoutMs).toBe(60000);
	});

	test("rejects non-positive / non-integer budgets", () => {
		const bad = (patch: Record<string, unknown>) =>
			parseManifest({ task: "t", sensors: [{ name: "a", cmd: "a" }], ...patch });
		expect(() => bad({ timeoutMs: 0 })).toThrow(/positive integer/);
		expect(() => bad({ agentTimeoutMs: -1 })).toThrow(/positive integer/);
		expect(() => bad({ timeoutMs: 1.5 })).toThrow(/positive integer/);
		expect(() =>
			parseManifest({ task: "t", sensors: [{ name: "a", cmd: "a", timeoutMs: 0 }] }),
		).toThrow(/sensors\[0\].timeoutMs/);
	});

	test("a timed-out sensor renders as a HANG, not a logic failure", () => {
		const r: SensorResult[] = [
			{ name: "test", cmd: "go test ./...", ok: false, exitCode: 137, output: "ok pkg/a", timedOut: true, durationMs: 600_000 },
		];
		const out = formatFailures(r);
		expect(out).toContain("TIMED OUT after 600s");
		expect(out).toContain("did not fail, it HUNG");
	});
});

describe("resource limits", () => {
	test("builds a systemd-run scope prefix", () => {
		expect(limitsArgs({ memoryMax: "8G", cpuQuota: "400%", tasksMax: 512 })).toEqual([
			"systemd-run", "-q", "--user", "--scope",
			"-p", "MemoryMax=8G",
			"-p", "CPUQuota=400%",
			"-p", "TasksMax=512",
			"--",
		]);
	});

	test("no limits => no prefix (never wrap when nothing is capped)", () => {
		expect(limitsArgs(undefined)).toEqual([]);
		expect(limitsArgs({})).toEqual([]);
	});

	test("partial limits only emit the configured properties", () => {
		expect(limitsArgs({ memoryMax: "1G" })).toEqual([
			"systemd-run", "-q", "--user", "--scope", "-p", "MemoryMax=1G", "--",
		]);
	});

	test("manifest.limits validates types", () => {
		expect(parseManifest({ task: "t", sensors: [{ name: "a", cmd: "a" }] }).limits).toBeUndefined();
		expect(
			parseManifest({ task: "t", limits: { memoryMax: "4G" }, sensors: [{ name: "a", cmd: "a" }] }).limits,
		).toEqual({ memoryMax: "4G" });
		expect(() => parseLimits({ tasksMax: "many" })).toThrow(/tasksMax/);
		expect(() => parseLimits({ memoryMax: "" })).toThrow(/memoryMax/);
		expect(() => parseLimits([])).toThrow(/must be an object/);
	});
});

describe("guide + standing rules", () => {
	test("manifest parses and defaults them to empty", () => {
		const m = parseManifest({ task: "t", sensors: [{ name: "a", cmd: "a" }] });
		expect(m.rules).toEqual([]);
		expect(m.guide).toEqual([]);
		const m2 = parseManifest({
			task: "t",
			rules: ["no new deps"],
			guide: ["PORTING.md", "LIFETIMES.tsv"],
			sensors: [{ name: "a", cmd: "a" }],
		});
		expect(m2.rules).toEqual(["no new deps"]);
		expect(m2.guide).toEqual(["PORTING.md", "LIFETIMES.tsv"]);
		expect(() =>
			parseManifest({ task: "t", rules: [1], sensors: [{ name: "a", cmd: "a" }] }),
		).toThrow(/manifest.rules/);
	});

	test("guide + rules appear on the FIRST iteration (no feedback yet)", () => {
		const p = buildPrompt("do the thing", undefined, undefined, undefined, ["no new deps"], ["PORTING.md"]);
		expect(p).toContain("do the thing");
		expect(p).toContain("READ THESE FILES FIRST");
		expect(p).toContain("PORTING.md");
		expect(p).toContain("no new deps");
		// still no feedback machinery on iteration 1
		expect(p).not.toContain("Automated checks failed");
	});

	test("guide + rules also ride along with feedback", () => {
		const p = buildPrompt("t", "### sensor \"build\" failed", [], "", ["rule one"], ["GUIDE.md"]);
		expect(p).toContain("GUIDE.md");
		expect(p).toContain("rule one");
		expect(p).toContain("Automated checks failed");
	});

	test("absent guide/rules add no guide/rules blocks (guardrails still stand)", () => {
		const bare = buildPrompt("t");
		const empty = buildPrompt("t", undefined, undefined, undefined, [], []);
		expect(bare).toBe(empty);
		expect(bare).not.toContain("READ THESE FILES FIRST");
		expect(bare).not.toContain("Standing rules");
		expect(bare.startsWith("t")).toBe(true);
		expect(bare).toContain("Ground rules"); // guardrails are unconditional
	});
});

describe("anti-cheat guardrails", () => {
	test("forbids stubbing and paragraph-long workaround justifications", () => {
		const p = buildPrompt("t", "### sensor \"build\" failed");
		expect(p).toContain("Do NOT stub, no-op, or TODO/unimplemented");
		expect(p).toContain("paragraph-long comment");
		// pre-existing guardrails still present
		expect(p).toContain("Do NOT delete, skip, or weaken tests");
		expect(p).toContain("Do NOT run git commit/reset/stash/tag");
	});
});

describe("canary verdicts", () => {
	test("a guard that goes red under the fault and back = flipped", () => {
		expect(judgeCanary(true, false, true)).toBe("flipped");
	});

	test("a feature sensor that goes green under a fake implementation = flipped", () => {
		// direction-agnostic: expect:"fail" sensors start red and must be able
		// to turn green, which is the unsatisfiability check.
		expect(judgeCanary(false, true, false)).toBe("flipped");
	});

	test("same state with the fault planted = stuck (gates nothing)", () => {
		expect(judgeCanary(true, true, true)).toBe("stuck");
		expect(judgeCanary(false, false, false)).toBe("stuck");
	});

	test("flipped but did not come back = not-restored", () => {
		expect(judgeCanary(true, false, false)).toBe("not-restored");
		expect(judgeCanary(false, true, true)).toBe("not-restored");
	});

	test("only stuck / not-restored / canary-failed are failures", () => {
		expect(isCanaryFailure("stuck")).toBe(true);
		expect(isCanaryFailure("not-restored")).toBe(true);
		expect(isCanaryFailure("canary-failed")).toBe(true);
		expect(isCanaryFailure("flipped")).toBe(false);
		expect(isCanaryFailure("unverified")).toBe(false);
	});

	test("manifest parses canary and rejects an empty one", () => {
		const m = parseManifest({
			task: "t",
			sensors: [
				{ name: "a", cmd: "a", canary: "echo boom > x" },
				{ name: "b", cmd: "b" },
			],
		});
		expect(m.sensors[0].canary).toBe("echo boom > x");
		expect(m.sensors[1].canary).toBeUndefined();
		expect(() =>
			parseManifest({ task: "t", sensors: [{ name: "a", cmd: "a", canary: "  " }] }),
		).toThrow(/canary must be a non-empty string/);
	});

	test("report names the stuck sensors and explains what stuck means", () => {
		const out = formatCanaryReport([
			{ name: "good", verdict: "flipped", baselineOk: true, canaryOk: false, restoredOk: true },
			{ name: "decorative", verdict: "stuck", baselineOk: true, canaryOk: true, restoredOk: true },
			{ name: "judge", verdict: "unverified" },
		]);
		expect(out).toContain("1/3 sensor(s) proven to discriminate; 1 unverified.");
		expect(out).toContain("STUCK");
		expect(out).toContain("decorative");
		expect(out).toContain("gate NOTHING");
		expect(out).toContain("judge");
	});

	// A feature sensor cannot carry a canary before its feature exists: the
	// fault you would plant IS the implementation. Listing it as a gap next to
	// an uncanaried guard overstates the problem in the one report you read
	// right before deciding to spend money - it read "9 unverified" when the
	// real number was 3.
	test("separates pending feature sensors from genuinely uncanaried guards", () => {
		const out = formatCanaryReport([
			{ name: "build", verdict: "flipped", baselineOk: true, canaryOk: false, restoredOk: true },
			{ name: "vet", verdict: "unverified" },
			{ name: "serve-healthz", verdict: "unverified", pending: true },
			{ name: "serve-405", verdict: "unverified", pending: true },
		]);
		expect(out).toContain("1/4 sensor(s) proven to discriminate; 1 unverified");
		expect(out).toContain("2 pending");
		// the real gap is named alone, not padded with sensors that cannot have one
		expect(out).toMatch(/Unverified \(no canary declared\):\n {2}vet\n/);
		expect(out).toContain("serve-healthz, serve-405");
		expect(out).toContain("expect: \"fail\"");
	});

	test("pending sensors alone do not read as an unverified backlog", () => {
		const out = formatCanaryReport([
			{ name: "build", verdict: "flipped", baselineOk: true, canaryOk: false, restoredOk: true },
			{ name: "serve-healthz", verdict: "unverified", pending: true },
		]);
		expect(out).toContain("1/2 sensor(s) proven to discriminate; 0 unverified");
		expect(out).not.toContain("Unverified (no canary declared)");
	});
});

describe("scope guard never reverts loop-owned state", () => {
	test(".pi/ is exempt even when writeScope excludes it", () => {
		const changed = [".pi/harness.json", ".pi/harness-report.json", "ops/ops.go", "run.log"];
		expect(outOfScope(changed, ["ops/**"])).toEqual(["run.log"]);
	});

	test("still reports genuinely out-of-scope paths", () => {
		expect(outOfScope(["docs/x.md", "ops/a.go"], ["ops/**"])).toEqual(["docs/x.md"]);
	});

	test("no writeScope means nothing is out of scope (unchanged)", () => {
		expect(outOfScope([".pi/harness.json", "anything"], [])).toEqual([]);
	});
});

describe("stuckSensors - per-sensor movement (what the aggregate count hides)", () => {
	const it_ = (pairs: [string, boolean][]) => ({
		sensors: pairs.map(([name, ok]) => ({ name, ok })),
	});

	test("names a sensor that never passed while others recovered", () => {
		// The measured miscalibration: build recovers, design-doc never can.
		expect(
			stuckSensors([
				it_([["build", false], ["design-doc", false]]),
				it_([["build", true], ["design-doc", false]]),
			]),
		).toEqual(["design-doc"]);
	});

	test("nothing stuck when every sensor passed at some point", () => {
		expect(
			stuckSensors([
				it_([["build", false], ["test", true]]),
				it_([["build", true], ["test", true]]),
			]),
		).toEqual([]);
	});

	test("all stuck when nothing ever passed", () => {
		expect(stuckSensors([it_([["a", false], ["b", false]]), it_([["a", false], ["b", false]])])).toEqual([
			"a",
			"b",
		]);
	});

	test("empty iteration list yields nothing", () => {
		expect(stuckSensors([])).toEqual([]);
	});

	test("preserves manifest order and does not duplicate", () => {
		expect(
			stuckSensors([it_([["z", false], ["a", false]]), it_([["z", false], ["a", false]])]),
		).toEqual(["z", "a"]);
	});
});

describe("formatReport", () => {
	const base = {
		task: "Implement the thing\nsecond line ignored",
		result: "fail",
		startedAt: "2026-08-04T10:00:00.000Z",
		finishedAt: "2026-08-04T10:02:30.000Z",
	};

	test("renders the failing trend, outcome and flags per iteration", () => {
		const out = formatReport({
			...base,
			iterations: [
				{ n: 1, model: "haiku", failingBefore: 3, failingAfter: 2, kept: true, progressed: true,
				  sensors: [{ name: "build", ok: true, durationMs: 1200 }, { name: "test", ok: false, durationMs: 9000 }] },
				{ n: 2, model: "sonnet", failingBefore: 2, failingAfter: 2, kept: false, progressed: false,
				  escalated: true, scopeViolations: ["docs/x.md"],
				  sensors: [{ name: "build", ok: true }, { name: "test", ok: false }] },
			],
		});
		expect(out).toContain("result: fail");
		expect(out).toContain("wall: 150s");
		expect(out).toContain("Implement the thing");
		expect(out).not.toContain("second line ignored");
		expect(out).toContain("3 -> 2");
		expect(out).toContain("ROLLED BACK");
		expect(out).toContain("ESCALATED");
		expect(out).toContain("scope-revert:1");
		expect(out).toContain("never passed: test");
		expect(out).toContain("slowest sensors:");
		// the report field is `iteration`; the renderer must not print "?"
		expect(formatReport({ ...base, iterations: [{ iteration: 7, failingBefore: 1, failingAfter: 0, kept: true, sensors: [] }] })).toContain(" 7  ");
	});

	test("flags an agent timeout", () => {
		const out = formatReport({
			...base,
			iterations: [{ n: 1, failingBefore: 1, failingAfter: 1, kept: false, agentTimedOut: true, sensors: [] }],
		});
		expect(out).toContain("AGENT-TIMEOUT");
	});

	test("handles an empty / minimal report without throwing", () => {
		expect(formatReport({})).toContain("no iterations recorded");
		expect(formatReport({ result: "pass", iterations: [] })).toContain("result: pass");
	});

	test("deduplicates notes and caps the list", () => {
		const many = Array.from({ length: 12 }, (_, i) => `note ${i}`);
		const out = formatReport({
			...base,
			iterations: [{ n: 1, kept: true, notes: [...many, "note 0"], sensors: [] }],
		});
		expect(out).toContain("note 0");
		expect(out).toContain("more");
	});

	// A stuck sensor's NAME is not a diagnosis. The judge sensor is the case
	// that proved it: 147s of opus review per iteration, and the report said
	// only "never passed: judge" - the reasoning had to be recovered by
	// re-running the sensor by hand.
	test("shows WHY each stuck sensor failed, from its last recorded output", () => {
		const out = formatReport({
			...base,
			iterations: [
				{
					n: 1,
					kept: true,
					sensors: [
						{ name: "build", ok: true },
						{ name: "judge", ok: false, output: "first-pass verdict" },
					],
				},
				{
					n: 2,
					kept: true,
					sensors: [
						{ name: "build", ok: true },
						{ name: "judge", ok: false, output: "REJECT: the handler is a stub" },
					],
				},
			],
		});
		expect(out).toContain("never passed: judge");
		expect(out).toContain("REJECT: the handler is a stub");
		// the LAST failure is the current state; earlier ones are superseded
		expect(out).not.toContain("first-pass verdict");
	});

	test("caps stuck-sensor output so a verbose judge cannot flood the report", () => {
		const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
		const out = formatReport({
			...base,
			iterations: [{ n: 1, kept: true, sensors: [{ name: "judge", ok: false, output: long }] }],
		});
		expect(out).toContain("line 59"); // the tail is what matters: the verdict
		expect(out).not.toContain("line 0\n");
		expect(out).toContain("more line");
	});

	// The prompt is the one thing the loop hands the model and never showed
	// back. Three of four defects found on the first real run came from
	// reading it by hand out of `ps` output.
	test("shows how big each iteration's prompt was", () => {
		const out = formatReport({
			...base,
			iterations: [
				{ n: 1, kept: true, promptChars: 4200, sensors: [] },
				{ n: 2, kept: false, promptChars: 31500, sensors: [] },
			],
		});
		expect(out).toContain("4.1k");
		expect(out).toContain("31k");
		expect(out).toContain("prompt");
	});

	test("omits the prompt column entirely when no iteration recorded one", () => {
		const out = formatReport({
			...base,
			iterations: [{ n: 1, kept: true, sensors: [] }],
		});
		expect(out).not.toContain("prompt");
	});

	test("says so when a stuck sensor recorded no output at all", () => {
		const out = formatReport({
			...base,
			iterations: [{ n: 1, kept: true, sensors: [{ name: "smoke", ok: false }] }],
		});
		expect(out).toContain("never passed: smoke");
		expect(out).toContain("no output recorded");
	});
});

describe("sensor gating: after", () => {
	test("parses a dependency list", () => {
		const m = parseManifest({
			task: "t",
			sensors: [
				{ name: "build", cmd: "true" },
				{ name: "judge", cmd: "true", after: ["build"] },
			],
		});
		expect(m.sensors[1].after).toEqual(["build"]);
	});

	test("a dependency must name a real sensor", () => {
		expect(() =>
			parseManifest({
				task: "t",
				sensors: [{ name: "judge", cmd: "true", after: ["buidl"] }],
			}),
		).toThrow(/unknown sensor "buidl"/);
	});

	// Declaration order is the cycle prevention: a sensor may only wait on one
	// already declared. No graph, no cycle detection, no surprises about which
	// pass a sensor runs in.
	test("a dependency must be declared EARLIER, which makes cycles impossible", () => {
		expect(() =>
			parseManifest({
				task: "t",
				sensors: [
					{ name: "judge", cmd: "true", after: ["build"] },
					{ name: "build", cmd: "true" },
				],
			}),
		).toThrow(/must be declared before/);
		expect(() =>
			parseManifest({ task: "t", sensors: [{ name: "a", cmd: "true", after: ["a"] }] }),
		).toThrow(/must be declared before/);
	});

	test("rejects a non-string-array after", () => {
		expect(() =>
			parseManifest({ task: "t", sensors: [{ name: "a", cmd: "true", after: "build" }] }),
		).toThrow(/after must be an array/);
	});
});

describe("blockedBy - which gated sensors cannot run this pass", () => {
	const s = (name: string, after?: string[]) => ({ name, cmd: "x", after });

	test("names the failed dependency", () => {
		expect(blockedBy(s("judge", ["build", "test"]), [
			{ name: "build", ok: false },
			{ name: "test", ok: true },
		])).toBe("build");
	});

	test("no dependency, or all green, means it runs", () => {
		expect(blockedBy(s("build"), [])).toBeNull();
		expect(blockedBy(s("judge", ["build"]), [{ name: "build", ok: true }])).toBeNull();
	});

	// A dependency that was itself skipped has not passed, so the dependent
	// cannot run either - otherwise a two-level gate silently collapses.
	test("a skipped dependency blocks too", () => {
		expect(blockedBy(s("judge", ["smoke"]), [{ name: "smoke", ok: false, skipped: true }])).toBe(
			"smoke",
		);
	});
});
