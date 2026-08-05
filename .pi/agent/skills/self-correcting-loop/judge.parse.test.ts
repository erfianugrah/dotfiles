import { describe, expect, test } from "bun:test";
import {
	type Args,
	buildJudgePrompt,
	buildVisualPrompt,
	isJudgeableDiff,
	isVisual,
	omitLoopArtifacts,
	parseArgs,
	parseVerdict,
} from "./judge.ts";

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
			url: "",
			screenshot: "",
			wait: "",
			viewport: "",
			fullPage: false,
			adversarial: 1,
		} satisfies Args);
	});

	test("--adversarial sets the reviewer count", () => {
		expect(parseArgs(["--spec", "x", "--adversarial", "3"]).adversarial).toBe(3);
	});

	test("--adversarial rejects non-positive / non-numeric values", () => {
		expect(() => parseArgs(["--spec", "x", "--adversarial", "0"])).toThrow("positive integer");
		expect(() => parseArgs(["--spec", "x", "--adversarial", "two"])).toThrow("positive integer");
	});

	test("parses visual-mode flags", () => {
		const a = parseArgs([
			"--spec", "page looks right",
			"--url", "http://localhost:4333/x",
			"--wait", "#app",
			"--viewport", "1280x800",
			"--full-page",
			"--screenshot", "/tmp/x.png",
		]);
		expect(a.url).toBe("http://localhost:4333/x");
		expect(a.wait).toBe("#app");
		expect(a.viewport).toBe("1280x800");
		expect(a.fullPage).toBe(true);
		expect(a.screenshot).toBe("/tmp/x.png");
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

describe("judge isVisual", () => {
	test("code mode by default", () => {
		expect(isVisual(parseArgs(["--spec", "s"]))).toBe(false);
	});
	test("--url => visual", () => {
		expect(isVisual(parseArgs(["--spec", "s", "--url", "http://x"]))).toBe(true);
	});
	test("--screenshot (no url) => visual", () => {
		expect(isVisual(parseArgs(["--spec", "s", "--screenshot", "/tmp/x.png"]))).toBe(true);
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

// The loop's own run log reached the reviewers as an untracked file and got
// written up as a defect: "committing a harness run log as the sole
// deliverable is unrequested scope". Unstaging it moved it from `git diff`
// into `git ls-files --others`, which the judge also collects - so the fix
// has to be here, not only in the checkpoint.
describe("judge omitLoopArtifacts", () => {
	test("drops the loop's own artifacts from the untracked list", () => {
		expect(
			omitLoopArtifacts([
				".pi/harness-run.log",
				".pi/harness-report.json",
				"internal/serve/serve.go",
			]),
		).toEqual(["internal/serve/serve.go"]);
	});

	test("matches by suffix, so a repo subdir is covered too", () => {
		expect(omitLoopArtifacts(["sub/.pi/harness-run.log", "sub/main.go"])).toEqual(["sub/main.go"]);
	});

	test("leaves the manifest alone - that IS reviewable work", () => {
		expect(omitLoopArtifacts([".pi/harness.json"])).toEqual([".pi/harness.json"]);
	});
});

// At baseline the tree matches the base ref, so an adversarial CODE judge
// spends minutes of a frontier model to conclude "nothing was built" - a
// guaranteed FAIL carrying no information, whose verbose reasoning then
// becomes iteration 1's "the previous attempt failed" feedback.
describe("judge isJudgeableDiff", () => {
	test("an empty diff is not worth a model call", () => {
		expect(isJudgeableDiff("")).toBe(false);
		expect(isJudgeableDiff("   \n\n")).toBe(false);
	});

	test("any real change is", () => {
		expect(isJudgeableDiff("diff --git a/x b/x\n+line")).toBe(true);
	});
});

describe("judge buildVisualPrompt", () => {
	test("embeds the absolute screenshot path, spec and output contract", () => {
		const p = buildVisualPrompt("header must not overflow", "/tmp/shot.png", "");
		expect(p).toContain("/tmp/shot.png");
		expect(p).toContain("read tool");
		expect(p).toContain("header must not overflow");
		expect(p).toContain("VERDICT: PASS");
		expect(p).toContain("VERDICT: FAIL");
	});

	test("judges rendered UI, not the diff", () => {
		const p = buildVisualPrompt("s", "/tmp/a.png", "");
		expect(p).toContain("UI/UX");
		expect(p).toContain("overflow");
		expect(p).not.toContain("git diff");
	});
});

describe("judge parseVerdict - markdown-decorated verdicts", () => {
	// A real reviewer (claude-haiku-4-5) emitted "**VERDICT: FAIL**" after
	// correctly diagnosing a planted spec violation. The old bare-line regex
	// could not match it, so a correct judgment was discarded as unparseable.
	// Fail-closed hid the damage that time; the symmetric case - a bolded
	// **VERDICT: PASS** - would have been silently converted into a FAIL and
	// blocked good work. Measured 2026-08-04, 1 in 8 runs.
	test("bold around the whole line", () => {
		expect(parseVerdict("reasons here\n**VERDICT: FAIL**").verdict).toBe("fail");
		expect(parseVerdict("reasons here\n**VERDICT: PASS**").verdict).toBe("pass");
	});

	test("bold around the label or the value only", () => {
		expect(parseVerdict("**VERDICT:** PASS").verdict).toBe("pass");
		expect(parseVerdict("VERDICT: **FAIL**").verdict).toBe("fail");
		expect(parseVerdict("__VERDICT: PASS__").verdict).toBe("pass");
	});

	test("heading, list-marker and blockquote prefixes", () => {
		expect(parseVerdict("## VERDICT: PASS").verdict).toBe("pass");
		expect(parseVerdict("- VERDICT: FAIL").verdict).toBe("fail");
		expect(parseVerdict("> VERDICT: PASS").verdict).toBe("pass");
		expect(parseVerdict("### **VERDICT: FAIL**").verdict).toBe("fail");
	});

	test("trailing punctuation and backticks", () => {
		expect(parseVerdict("VERDICT: PASS.").verdict).toBe("pass");
		expect(parseVerdict("`VERDICT: FAIL`").verdict).toBe("fail");
	});

	test("still refuses prose mentions and unknown values", () => {
		expect(parseVerdict("the VERDICT: PASS was inline").verdict).toBe("unknown");
		expect(parseVerdict("VERDICT: MAYBE").verdict).toBe("unknown");
		expect(parseVerdict("my verdict is that it passes").verdict).toBe("unknown");
	});

	test("last verdict still wins, and reasons stop before it", () => {
		const r = parseVerdict("first thoughts\nVERDICT: PASS\nrethinking\n**VERDICT: FAIL**");
		expect(r.verdict).toBe("fail");
		expect(r.reasons).toContain("rethinking");
	});
});
