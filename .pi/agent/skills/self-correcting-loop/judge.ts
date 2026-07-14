#!/usr/bin/env bun
/**
 * judge.ts - an INFERENTIAL sensor (LLM-as-judge) for the self-correcting loop.
 *
 *   CODE mode (default): review a git diff against the spec
 *     bun judge.ts --spec "<task/spec>" [--base HEAD] [--model M]
 *                  [--rubric "extra criteria"] [--lenient] [--tools read,bash]
 *
 *   VISUAL mode (UI/UX awareness for a live dev server): screenshot a URL and
 *   have a vision-capable model assess the rendered page against the spec
 *     bun judge.ts --spec "<UX criteria>" --url http://localhost:4333/path
 *                  [--wait '#app'] [--viewport 1280x800] [--full-page]
 *                  [--screenshot out.png] [--model M] [--lenient]
 *   (or judge a pre-captured PNG: --screenshot path.png with no --url)
 *
 * Bockeler's harness engineering splits sensors into COMPUTATIONAL (tests,
 * linters, type checkers - deterministic, cheap, every change) and INFERENTIAL
 * (semantic AI review / "LLM as judge" - slower, non-deterministic, richer
 * judgment). The rest of this harness gates only on computational sensors;
 * judge.ts adds the inferential column as an actual GATE. CODE mode feeds the
 * git diff to a SECOND `pi -p` (ideally a different / stronger model than the
 * one writing the code) and asks whether the change satisfies the spec. VISUAL
 * mode captures the live page via browser-assert and asks a vision model to
 * judge the rendered UI/UX - the behaviour-harness sensor a DOM assert can't be
 * (layout, overflow, contrast, broken rendering). Either way exit 0 = pass,
 * non-zero = fail, so it drops straight into a manifest `sensors[]` entry.
 *
 * Because it is expensive and probabilistic, run it as the LAST sensor, after
 * the cheap computational gates are green (keep quality left). CODE mode closes
 * the "green-but-wrong / misunderstood instruction" gap; VISUAL mode closes the
 * "renders in the DOM but looks broken" gap that no build/test/DOM-assert sees.
 *
 * Fail-closed by default: an unparseable / errored judgment counts as FAIL, so
 * the loop keeps trying rather than declaring victory on an unclear verdict.
 * --lenient flips that to fail-open (unclear = pass) for noisy judges.
 *
 * Testability: the judge command is `$LOOP_JUDGE_CMD` (default "pi") and the
 * capture command is `$LOOP_CAPTURE_CMD` (default `bun browser-assert.ts`), so
 * an integration test can substitute scripted fakes for both.
 */

import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

const JUDGE_CMD = process.env.LOOP_JUDGE_CMD ?? "pi";
const SCRIPT_DIR = dirname(Bun.fileURLToPath(import.meta.url));

export interface Args {
	/** the spec / task the evidence is judged against (feed-forward instruction). */
	spec: string;
	/** git ref to diff against (default HEAD - the loop's baseline commit). */
	base: string;
	/** model for the judge; "" = pi default. Prefer a DIFFERENT model. */
	model: string;
	/** extra review criteria appended to the rubric. */
	rubric: string;
	/** pi --tools whitelist for the judge (read-only by default). */
	tools: string[];
	/** unclear/errored verdict = pass (default false = fail-closed). */
	lenient: boolean;
	/** VISUAL mode: live URL to screenshot via browser-assert before judging. */
	url: string;
	/** VISUAL mode: screenshot path (capture target if --url, else PNG to judge). */
	screenshot: string;
	/** VISUAL capture: selector to wait for before shooting (passed to browser-assert). */
	wait: string;
	/** VISUAL capture: viewport WxH (passed to browser-assert). */
	viewport: string;
	/** VISUAL capture: full-page screenshot (passed to browser-assert). */
	fullPage: boolean;
}

const DEFAULT_TOOLS = ["read"];

/**
 * Pure arg parser. Throws on misuse (main prints usage + exits 2). `--spec` is
 * the only required flag.
 */
export function parseArgs(argv: string[]): Args {
	const a: Args = {
		spec: "",
		base: "HEAD",
		model: "",
		rubric: "",
		tools: [...DEFAULT_TOOLS],
		lenient: false,
		url: "",
		screenshot: "",
		wait: "",
		viewport: "",
		fullPage: false,
	};
	const need = (i: number, flag: string): string => {
		const v = argv[i + 1];
		if (v === undefined || v.startsWith("--")) throw new Error(`${flag} wants a value`);
		return v;
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--spec": a.spec = need(i, "--spec"); i++; break;
			case "--base": a.base = need(i, "--base"); i++; break;
			case "--model": a.model = need(i, "--model"); i++; break;
			case "--rubric": a.rubric = need(i, "--rubric"); i++; break;
			case "--tools": a.tools = need(i, "--tools").split(",").map((t) => t.trim()).filter(Boolean); i++; break;
			case "--lenient": a.lenient = true; break;
			case "--url": a.url = need(i, "--url"); i++; break;
			case "--screenshot": a.screenshot = need(i, "--screenshot"); i++; break;
			case "--wait": a.wait = need(i, "--wait"); i++; break;
			case "--viewport": a.viewport = need(i, "--viewport"); i++; break;
			case "--full-page": a.fullPage = true; break;
			default:
				throw new Error(`unknown arg: ${arg}`);
		}
	}
	if (!a.spec.trim()) throw new Error("usage: judge.ts --spec <spec> [--base ref] [--url URL | --screenshot PNG] [--wait sel] [--viewport WxH] [--full-page] [--model M] [--rubric ...] [--tools ...] [--lenient]");
	return a;
}

/** True when the judge should assess a rendered screenshot, not a code diff. */
export function isVisual(a: Args): boolean {
	return a.url.trim() !== "" || a.screenshot.trim() !== "";
}

export type Verdict = "pass" | "fail" | "unknown";

/**
 * Extract the verdict from the judge's stdout. Contract: the judge ends its
 * response with a line `VERDICT: PASS` or `VERDICT: FAIL`. We scan for the LAST
 * such marker (so reasoning that quotes the words earlier doesn't fool it) and
 * return everything before it as the reasons blob.
 */
export function parseVerdict(stdout: string): { verdict: Verdict; reasons: string } {
	const re = /^\s*VERDICT:\s*(PASS|FAIL)\s*$/gim;
	let m: RegExpExecArray | null;
	let last: { verdict: Verdict; index: number } | null = null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop.
	while ((m = re.exec(stdout)) !== null) {
		last = { verdict: m[1].toUpperCase() === "PASS" ? "pass" : "fail", index: m.index };
	}
	if (!last) return { verdict: "unknown", reasons: stdout.trim() };
	return { verdict: last.verdict, reasons: stdout.slice(0, last.index).trim() };
}

const VERDICT_CONTRACT = [
	"Reply with a short REASONS section, then end with EXACTLY ONE line that is",
	"either `VERDICT: PASS` or `VERDICT: FAIL`. The last VERDICT line is authoritative.",
];

/** Build the strict, output-contracted CODE-review prompt. Pure. */
export function buildJudgePrompt(spec: string, diff: string, rubric: string): string {
	const criteria = rubric.trim()
		? `\nAdditional criteria for THIS task:\n${rubric.trim()}\n`
		: "";
	const body = diff.trim() || "(no diff - the working tree matches the base ref)";
	return [
		"You are a strict code reviewer acting as an INFERENTIAL completion gate.",
		"A coding agent was told to make a change. Decide whether the diff below",
		"genuinely satisfies the SPEC - not merely whether it compiles or the tests",
		"pass (separate computational sensors already checked that). Judge intent,",
		"correctness against the spec, obvious bugs, misunderstood instructions,",
		"and unrequested scope creep. Do NOT reward green tests the change itself",
		"could have weakened.",
		"",
		"SPEC:",
		spec.trim(),
		criteria,
		"DIFF (git diff against the baseline):",
		"```diff",
		body,
		"```",
		"",
		`PASS = the change satisfies the spec. FAIL = it does not. ${VERDICT_CONTRACT[0]}`,
		VERDICT_CONTRACT[1],
	].join("\n");
}

/**
 * Build the strict, output-contracted VISUAL-review prompt. Pure. The model is
 * told to open the screenshot with its `read` tool (pi renders PNGs to the
 * model), so the path must be absolute.
 */
export function buildVisualPrompt(spec: string, screenshotAbsPath: string, rubric: string): string {
	const criteria = rubric.trim()
		? `\nAdditional criteria for THIS page:\n${rubric.trim()}\n`
		: "";
	return [
		"You are a strict UI/UX reviewer acting as an INFERENTIAL completion gate.",
		`Use your read tool to open the screenshot at: ${screenshotAbsPath}`,
		"It is a render of a live dev server. Separate computational sensors already",
		"confirmed the page builds and the DOM asserts hold; your job is what they",
		"cannot see: does the RENDERED page look right and usable? Judge layout and",
		"alignment, overflow / clipping / horizontal scroll, contrast and legibility,",
		"obvious visual breakage (unstyled flash, overlap, missing images, raw markup",
		"or error banners), and whether it satisfies the SPEC. Be concrete about what",
		"is wrong and where.",
		"",
		"SPEC:",
		spec.trim(),
		criteria,
		`PASS = the rendered UI is correct and usable per the spec. FAIL = it is not. ${VERDICT_CONTRACT[0]}`,
		VERDICT_CONTRACT[1],
	].join("\n");
}

// --- impure shell (only runs as a script) -----------------------------------

async function sh(cmd: string[]): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out: `${stdout}${stderr}` };
}

async function collectDiff(base: string): Promise<string> {
	const tracked = (await sh(["git", "diff", base])).out;
	// Include untracked files so a brand-new file is judged, not invisible.
	const others = (await sh(["git", "ls-files", "--others", "--exclude-standard"])).out
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	let extra = "";
	for (const f of others) {
		const content = (await sh(["git", "diff", "--no-index", "/dev/null", f])).out;
		if (content) extra += `\n${content}`;
	}
	return `${tracked}${extra}`;
}

/**
 * VISUAL mode: capture a screenshot of the live URL via browser-assert (or
 * accept a pre-captured PNG), returning its absolute path. The capture command
 * is overridable via `$LOOP_CAPTURE_CMD` for tests. Throws on capture failure.
 */
async function obtainScreenshot(a: Args): Promise<string> {
	// No URL: judge an already-captured PNG.
	if (!a.url.trim()) return resolve(a.screenshot);

	const out = a.screenshot.trim() ? resolve(a.screenshot) : resolve(tmpdir(), `judge-ux-${Date.now()}.png`);
	const base = (process.env.LOOP_CAPTURE_CMD ?? `bun ${SCRIPT_DIR}/browser-assert.ts`).split(" ").filter(Boolean);
	const cmd = [...base, a.url];
	if (a.wait) cmd.push("--wait", a.wait);
	if (a.viewport) cmd.push("--viewport", a.viewport);
	if (a.fullPage) cmd.push("--full-page");
	cmd.push("--screenshot", out);
	const { code, out: log } = await sh(cmd);
	if (code !== 0) throw new Error(`capture failed (browser-assert exit ${code}):\n${log.trim().slice(0, 1000)}`);
	return out;
}

async function main(): Promise<number> {
	let args: Args;
	try {
		args = parseArgs(Bun.argv.slice(2));
	} catch (err) {
		console.error((err as Error).message);
		return 2;
	}

	let prompt: string;
	if (isVisual(args)) {
		let shot: string;
		try {
			shot = await obtainScreenshot(args);
		} catch (err) {
			console.error((err as Error).message);
			return args.lenient ? 0 : 1; // capture failure = fail-closed by default.
		}
		prompt = buildVisualPrompt(args.spec, shot, args.rubric);
		// The judge must be able to read the PNG.
		if (!args.tools.includes("read")) args.tools.push("read");
	} else {
		prompt = buildJudgePrompt(args.spec, await collectDiff(args.base), args.rubric);
	}

	const cmd = [JUDGE_CMD, "-p", prompt, "--tools", args.tools.join(","), "-a"];
	if (args.model) cmd.push("--model", args.model);
	const { code, out } = await sh(cmd);
	if (code !== 0) {
		console.error(`judge: agent exited ${code}`);
		// fall through - still try to parse a verdict from partial output.
	}

	const { verdict, reasons } = parseVerdict(out);
	if (verdict === "pass") {
		console.log("judge: PASS");
		return 0;
	}
	if (verdict === "fail") {
		console.log(`judge: FAIL\n${reasons}`);
		return 1;
	}
	// unknown
	if (args.lenient) {
		console.log("judge: no parseable verdict; --lenient => PASS");
		return 0;
	}
	console.error(`judge: no parseable verdict (fail-closed => FAIL)\n${out.trim().slice(0, 2000)}`);
	return 1;
}

if (import.meta.main) process.exit(await main());
