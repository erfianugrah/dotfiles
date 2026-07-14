import { describe, expect, test } from "bun:test";
import { type Args, buildJudgePrompt, parseArgs, parseVerdict } from "./judge.ts";

describe("judge parseArgs", () => {
	test("requires --spec", () => {
		expect(() => parseArgs([])).toThrow("usage");
		expect(() => parseArgs(["--base", "HEAD"])).toThrow("usage");
	});

	test("defaults", () => {
		const a = parseArgs(["--spec", "add a foo endpoint"]);
		expect(a).toEqual({
			spec: "add a foo endpoint",
			base: "HEAD",
			model: "",
			rubric: "",
			tools: ["read"],
			lenient: false,
		} satisfies Args);
	});

	test("parses all flags", () => {
		const a = parseArgs([
			"--spec", "s",
			"--base", "main",
			"--model", "claude-opus-4-8",
			"--rubric", "must be idempotent",
			"--tools", "read, bash ,grep",
			"--lenient",
		]);
		expect(a.base).toBe("main");
		expect(a.model).toBe("claude-opus-4-8");
		expect(a.rubric).toBe("must be idempotent");
		expect(a.tools).toEqual(["read", "bash", "grep"]);
		expect(a.lenient).toBe(true);
	});

	test("a flag missing its value throws", () => {
		expect(() => parseArgs(["--spec", "--base"])).toThrow("--spec wants a value");
		expect(() => parseArgs(["--spec", "s", "--model"])).toThrow("--model wants a value");
	});

	test("rejects unknown args", () => {
		expect(() => parseArgs(["--spec", "s", "--nope"])).toThrow("unknown arg: --nope");
	});
});

describe("judge parseVerdict", () => {
	test("PASS on its own line", () => {
		expect(parseVerdict("looks good\nVERDICT: PASS\n")).toEqual({
			verdict: "pass",
			reasons: "looks good",
		});
	});

	test("FAIL carries the reasons blob before the marker", () => {
		const r = parseVerdict("REASONS:\n- missing null check\nVERDICT: FAIL");
		expect(r.verdict).toBe("fail");
		expect(r.reasons).toContain("missing null check");
	});

	test("takes the LAST verdict when the words appear earlier in prose", () => {
		const out = "I could say VERDICT: PASS but actually no.\nVERDICT: FAIL\n";
		expect(parseVerdict(out).verdict).toBe("fail");
	});

	test("case-insensitive marker", () => {
		expect(parseVerdict("verdict: pass").verdict).toBe("pass");
	});

	test("no marker => unknown, whole output is the reasons", () => {
		const r = parseVerdict("the model rambled and never concluded");
		expect(r.verdict).toBe("unknown");
		expect(r.reasons).toBe("the model rambled and never concluded");
	});

	test("a VERDICT substring inside a sentence does NOT match (anchored line)", () => {
		expect(parseVerdict("the VERDICT: PASS was inline").verdict).toBe("unknown");
	});
});

describe("judge buildJudgePrompt", () => {
	test("embeds spec, diff and the output contract", () => {
		const p = buildJudgePrompt("do X", "+added line", "");
		expect(p).toContain("do X");
		expect(p).toContain("+added line");
		expect(p).toContain("VERDICT: PASS");
		expect(p).toContain("VERDICT: FAIL");
	});

	test("includes extra rubric when given", () => {
		expect(buildJudgePrompt("s", "d", "must be idempotent")).toContain("must be idempotent");
	});

	test("empty diff is spelled out, not left blank", () => {
		expect(buildJudgePrompt("s", "   ", "")).toContain("no diff");
	});
});
