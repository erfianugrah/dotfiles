#!/usr/bin/env bun
/**
 * judge.ts - an INFERENTIAL sensor (LLM-as-judge) for the self-correcting loop.
 *
 *   bun judge.ts --spec "<task/spec>" [--base HEAD] [--model M]
 *                [--rubric "extra criteria"] [--lenient] [--tools read,bash]
 *
 * Bockeler's harness engineering splits sensors into COMPUTATIONAL (tests,
 * linters, type checkers - deterministic, cheap, every change) and INFERENTIAL
 * (semantic AI review / "LLM as judge" - slower, non-deterministic, richer
 * judgment). The rest of this harness gates only on computational sensors;
 * judge.ts adds the inferential column as an actual GATE: it feeds the current
 * git diff + the spec to a SECOND `pi -p` (ideally a different / stronger model
 * than the one writing the code) and asks whether the change satisfies the
 * spec. Exit 0 = satisfied, non-zero = not - so it drops straight into a
 * manifest `sensors[]` entry like any other command.
 *
 * Because it is expensive and probabilistic, run it as the LAST sensor, after
 * the cheap computational gates are green (keep quality left). It closes the
 * "green-but-wrong / misunderstood instruction" gap that no build/test can.
 *
 * Fail-closed by default: an unparseable / errored judgment counts as FAIL, so
 * the loop keeps trying rather than declaring victory on an unclear verdict.
 * --lenient flips that to fail-open (unclear = pass) for noisy judges.
 *
 * Testability: the judge command is `$LOOP_JUDGE_CMD` (default "pi"), so an
 * integration test can substitute a scripted fake judge.
 */

import { basename } from "node:path";

const JUDGE_CMD = process.env.LOOP_JUDGE_CMD ?? "pi";

export interface Args {
	/** the spec / task the diff is judged against (feed-forward instruction). */
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
			default:
				throw new Error(`unknown arg: ${arg}`);
		}
	}
	if (!a.spec.trim()) throw new Error("usage: judge.ts --spec <spec> [--base ref] [--model M] [--rubric ...] [--tools ...] [--lenient]");
	return a;
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

/** Build the strict, output-contracted review prompt. Pure. */
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
		"Reply with a short REASONS section, then end with EXACTLY ONE line that is",
		"either `VERDICT: PASS` (the change satisfies the spec) or `VERDICT: FAIL`",
		"(it does not). The last VERDICT line is authoritative.",
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

async function main(): Promise<number> {
	let args: Args;
	try {
		args = parseArgs(Bun.argv.slice(2));
	} catch (err) {
		console.error((err as Error).message);
		return 2;
	}

	const diff = await collectDiff(args.base);
	const prompt = buildJudgePrompt(args.spec, diff, args.rubric);

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
