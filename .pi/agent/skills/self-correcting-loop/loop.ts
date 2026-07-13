#!/usr/bin/env bun
/**
 * loop.ts - sensor-gated self-correcting loop driver (v2: cybernetic governor).
 *
 *   bun loop.ts run   [--manifest .pi/harness.json] [--model M] [--max N] [--dry]
 *   bun loop.ts init  [go|node|rust|astro|python]   [--force]
 *
 * Each iteration spawns a FRESH `pi -p` (state lives in the filesystem + the
 * injected sensor feedback, never a bloating conversation), runs the manifest
 * sensors, and applies a control loop around them:
 *
 *   - git checkpoint: the index is "best known good". A regressing or stalled
 *     iteration is rolled back to it, so the loop can never degrade.
 *   - write-scope: edits outside manifest.writeScope are reverted each turn.
 *   - escalation ladder: start on the cheapest model, climb a rung after
 *     `stallPatience` consecutive no-progress iterations.
 *   - report: per-iteration record written to .pi/harness-report.json.
 *
 * The model never decides completion - sensor exit codes do.
 *
 * Testability: the agent command is `$LOOP_PI_CMD` (default "pi"), so an
 * integration test can substitute a scripted fake agent.
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
	type LadderState,
	type Manifest,
	type SensorResult,
	advanceLadder,
	allPass,
	buildPrompt,
	countFailing,
	decide,
	detectPreset,
	fingerprint,
	formatFailures,
	modelAt,
	outOfScope,
	parseManifest,
} from "./harness.ts";

const SCRIPT_DIR = dirname(Bun.fileURLToPath(import.meta.url));
const PRESET_DIR = join(SCRIPT_DIR, "presets");
const DEFAULT_MANIFEST = ".pi/harness.json";
const REPORT_PATH = ".pi/harness-report.json";
const PI_CMD = process.env.LOOP_PI_CMD ?? "pi";

// --- arg parsing ------------------------------------------------------------

function parseArgs(argv: string[]): {
	cmd: string;
	positional: string[];
	flags: Record<string, string | boolean>;
} {
	const [cmd = "run", ...rest] = argv;
	const flags: Record<string, string | boolean> = {};
	const positional: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = rest[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				i++;
			} else {
				flags[key] = true;
			}
		} else {
			positional.push(a);
		}
	}
	return { cmd, positional, flags };
}

// --- shelling out -----------------------------------------------------------

async function sh(cmd: string[]): Promise<{ code: number; out: string }> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out: `${stdout}${stderr}`.trim() };
}

const git = (...args: string[]) => sh(["git", ...args]);

async function isGitRepo(): Promise<boolean> {
	return (await git("rev-parse", "--is-inside-work-tree")).code === 0;
}

async function isDirty(): Promise<boolean> {
	return (await git("status", "--porcelain")).out.trim() !== "";
}

/**
 * Paths that differ from the baseline commit (HEAD), plus untracked files.
 * Uses name-only plumbing (no status-column prefix) so parsing is robust -
 * porcelain's leading space on unstaged lines is a slicing trap.
 */
async function changedPaths(): Promise<string[]> {
	const tracked = (await git("diff", "--name-only", "HEAD")).out;
	const untracked = (await git("ls-files", "--others", "--exclude-standard")).out;
	const set = new Set<string>();
	for (const l of `${tracked}\n${untracked}`.split("\n")) {
		const p = l.trim();
		if (p) set.add(p);
	}
	return [...set];
}

/** Promote the working tree to the "best known good" checkpoint (the index). */
async function checkpoint(): Promise<void> {
	await git("add", "-A");
}

/** Restore the working tree to the last checkpoint. */
async function rollback(): Promise<void> {
	await git("checkout", "--", ".");
	await git("clean", "-fdq");
}

/** Revert the given paths to the baseline commit (used for scope violations). */
async function revertPaths(paths: string[]): Promise<void> {
	for (const p of paths) {
		await git("checkout", "HEAD", "--", p); // tracked -> baseline
		await git("clean", "-fdq", "--", p); // untracked -> removed
	}
}

async function runSensor(name: string, cmd: string): Promise<SensorResult> {
	const { code, out } = await sh(["bash", "-lc", cmd]);
	return { name, cmd, ok: code === 0, exitCode: code, output: out };
}

async function runAllSensors(m: Manifest): Promise<SensorResult[]> {
	const results: SensorResult[] = [];
	for (const s of m.sensors) {
		process.stdout.write(`    - ${s.name} ... `);
		const r = await runSensor(s.name, s.cmd);
		console.log(r.ok ? "pass" : `FAIL (exit ${r.exitCode})`);
		results.push(r);
	}
	return results;
}

/** Spawn one agent iteration (pi -p, or $LOOP_PI_CMD in tests). */
async function runAgent(prompt: string, model: string, tools: string[]): Promise<number> {
	const args = ["-p", prompt, "--tools", tools.join(","), "-a"];
	if (model) args.push("--model", model);
	const proc = Bun.spawn([PI_CMD, ...args], {
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
	});
	return await proc.exited;
}

// --- report -----------------------------------------------------------------

interface IterationRecord {
	iteration: number;
	model: string;
	failingBefore: number;
	failingAfter: number;
	progressed: boolean;
	kept: boolean;
	escalated: boolean;
	scopeViolations: string[];
	sensors: { name: string; ok: boolean; exitCode: number }[];
}

interface RunReport {
	startedAt: string;
	finishedAt: string;
	task: string;
	models: string[];
	result: "pass" | "fail" | "already-green";
	iterations: IterationRecord[];
}

// --- commands ---------------------------------------------------------------

async function cmdRun(flags: Record<string, string | boolean>): Promise<number> {
	const manifestPath = resolve(
		typeof flags.manifest === "string" ? flags.manifest : DEFAULT_MANIFEST,
	);
	if (!existsSync(manifestPath)) {
		console.error(`no manifest at ${manifestPath}\nrun \`bun loop.ts init\` first.`);
		return 2;
	}

	let m: Manifest;
	try {
		m = parseManifest(await Bun.file(manifestPath).json());
	} catch (err) {
		console.error(`invalid manifest: ${(err as Error).message}`);
		return 2;
	}

	// CLI overrides.
	if (typeof flags.model === "string") m.models = [flags.model];
	if (typeof flags.max === "string") {
		const n = Number.parseInt(flags.max, 10);
		if (Number.isInteger(n) && n > 0) m.maxIterations = n;
	}
	const dry = flags.dry === true;

	console.log(`loop: ${manifestPath}`);
	console.log(`  models:  ${m.models.map((x) => x || "(pi default)").join(" -> ")}`);
	console.log(`  max:     ${m.maxIterations}  stallPatience: ${m.stallPatience}`);
	console.log(`  tools:   ${m.tools.join(",")}`);
	console.log(`  scope:   ${m.writeScope.length ? m.writeScope.join(", ") : "(unrestricted)"}`);
	console.log(`  sensors: ${m.sensors.map((s) => s.name).join(", ")}`);

	// Refuse to run on a dirty tree: the loop checkpoints with `git add -A` and
	// rolls back with checkout/clean, which would fold uncommitted work into its
	// snapshots. --dry does no git ops, so it is exempt.
	const gitOn = await isGitRepo();
	if (!dry && gitOn && flags["allow-dirty"] !== true && (await isDirty())) {
		console.error(
			"working tree is dirty; the loop's checkpoint/rollback (git add -A / checkout / clean) would fold your uncommitted work into its snapshots.\ncommit or stash first, or re-run with --allow-dirty.",
		);
		return 2;
	}

	// Baseline sensor run (also the --dry output).
	console.log("\n  baseline sensors:");
	let prev = await runAllSensors(m);
	if (allPass(prev)) {
		console.log("\nall sensors green (nothing for the loop to do).");
		return 0;
	}
	if (dry) {
		console.log(`\n[dry run]\n${formatFailures(prev)}`);
		return 1;
	}

	// Control-loop state.
	if (!gitOn) {
		console.warn(
			"\n  ! not a git repo: checkpoint/rollback/scope-guard disabled (feed-forward only).",
		);
	} else {
		await checkpoint(); // index := current working tree (best known good).
	}

	let ladder: LadderState = { rung: 0, noProgress: 0 };
	let prevFailing = countFailing(prev);
	let prevFp = fingerprint(prev);
	const report: RunReport = {
		startedAt: new Date().toISOString(),
		finishedAt: "",
		task: m.task,
		models: m.models,
		result: "fail",
		iterations: [],
	};

	for (let i = 1; i <= m.maxIterations; i++) {
		const model = modelAt(m.models, ladder.rung);
		const notes: string[] = [];
		console.log(
			`\n=== iteration ${i}/${m.maxIterations}  [model: ${model || "pi default"}, rung ${ladder.rung}] ===`,
		);

		const feedback = formatFailures(prev);
		const prompt = buildPrompt(m.task, feedback, iterationNotes(report));
		const agentExit = await runAgent(prompt, model, m.tools);
		if (agentExit !== 0) console.warn(`  (agent exited ${agentExit}; continuing)`);

		// Enforce write-scope.
		let scopeViolations: string[] = [];
		if (gitOn && m.writeScope.length) {
			const bad = outOfScope(await changedPaths(), m.writeScope);
			if (bad.length) {
				await revertPaths(bad);
				scopeViolations = bad;
				notes.push(
					`Reverted ${bad.length} out-of-scope edit(s): ${bad.join(", ")}. Only write: ${m.writeScope.join(", ")}.`,
				);
				console.log(`  ! reverted out-of-scope edits: ${bad.join(", ")}`);
			}
		}

		console.log("  sensors:");
		const cur = await runAllSensors(m);
		const curFailing = countFailing(cur);
		const curFp = fingerprint(cur);
		const d = decide(prevFailing, prevFp, curFailing, curFp);

		console.log(
			`  -> failing ${prevFailing} -> ${curFailing}  (${d.done ? "DONE" : d.progressed ? "progress" : "no progress"})`,
		);

		if (d.keep && gitOn) await checkpoint();
		else if (gitOn) {
			await rollback();
			notes.push("Your last change did not help and was rolled back. Try a different approach.");
			console.log("  ! rolled back to last good checkpoint");
		}

		const adv = advanceLadder(ladder, d.progressed, m.stallPatience, m.models.length);
		if (adv.escalated) {
			console.log(
				`  ^ escalating model rung ${ladder.rung} -> ${adv.state.rung} (${modelAt(m.models, adv.state.rung) || "pi default"})`,
			);
		}
		ladder = adv.state;

		report.iterations.push({
			iteration: i,
			model,
			failingBefore: prevFailing,
			failingAfter: curFailing,
			progressed: d.progressed,
			kept: d.keep,
			escalated: adv.escalated,
			scopeViolations,
			sensors: cur.map((s) => ({ name: s.name, ok: s.ok, exitCode: s.exitCode })),
		});

		if (d.keep) {
			// Kept: current becomes the new best.
			prev = cur;
			prevFailing = curFailing;
			prevFp = curFp;
		}
		// If rolled back, prev/prevFailing/prevFp stay = best known good.

		if (d.done) {
			report.result = "pass";
			report.finishedAt = new Date().toISOString();
			await writeReport(report);
			console.log(`\nPASS: all sensors green on iteration ${i}.`);
			return 0;
		}
	}

	report.finishedAt = new Date().toISOString();
	await writeReport(report);
	console.error(`\nFAIL: sensors still red after ${m.maxIterations} iterations.`);
	return 1;
}

/** Notes derived from the previous iteration record (rollback/escalation). */
function iterationNotes(report: RunReport): string[] {
	const last = report.iterations.at(-1);
	if (!last) return [];
	const notes: string[] = [];
	if (!last.kept) notes.push("The previous attempt was rolled back (no progress); try a different approach.");
	if (last.escalated) notes.push("A stronger model is now handling this - reconsider the problem from scratch.");
	return notes;
}

async function writeReport(report: RunReport): Promise<void> {
	try {
		await Bun.$`mkdir -p ${dirname(REPORT_PATH)}`.quiet();
		await Bun.write(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
		console.log(`  report: ${REPORT_PATH}`);
	} catch {
		/* best-effort */
	}
}

async function cmdInit(
	positional: string[],
	flags: Record<string, string | boolean>,
): Promise<number> {
	let preset = positional[0];
	if (!preset) {
		const detected = detectPreset(readdirSync(process.cwd()));
		if (!detected) {
			console.error(
				"could not detect stack; pass one explicitly: init [go|node|rust|astro|python]",
			);
			return 2;
		}
		preset = detected;
		console.log(`detected stack: ${preset}`);
	}

	const presetPath = join(PRESET_DIR, `${preset}.json`);
	if (!existsSync(presetPath)) {
		console.error(`unknown preset "${preset}" (looked in ${PRESET_DIR})`);
		return 2;
	}

	const out = resolve(DEFAULT_MANIFEST);
	if (existsSync(out) && flags.force !== true) {
		console.error(`${out} exists; pass --force to overwrite.`);
		return 2;
	}

	const presetJson = await Bun.file(presetPath).json();
	parseManifest(presetJson); // validate before writing.
	await Bun.$`mkdir -p ${dirname(out)}`.quiet();
	await Bun.write(out, `${JSON.stringify(presetJson, null, 2)}\n`);
	console.log(`wrote ${out} from ${preset} preset.`);
	console.log("edit the `task` field, then: bun loop.ts run");
	return 0;
}

async function main(): Promise<void> {
	const { cmd, positional, flags } = parseArgs(Bun.argv.slice(2));
	let code: number;
	switch (cmd) {
		case "run":
			code = await cmdRun(flags);
			break;
		case "init":
			code = await cmdInit(positional, flags);
			break;
		default:
			console.error(`unknown command "${cmd}"\nusage: bun loop.ts [run|init] ...`);
			code = 2;
	}
	process.exit(code);
}

if (basename(Bun.main) === "loop.ts") {
	await main();
}
