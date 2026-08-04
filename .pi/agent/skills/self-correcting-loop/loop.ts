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
 *   - ref-guard: if the agent moves HEAD (git commit/reset), the move is
 *     undone (reset --soft to the checkpoint HEAD), so a commit can never
 *     sneak changes past the scope fence or the rollback.
 *   - index-guard: the checkpoint index is re-imposed from its write-tree
 *     snapshot after EVERY iteration, neutralizing HEAD-preserving attacks:
 *     reset --hard / checkout -- . (checkpoint destruction), update-index
 *     --skip-worktree (fence evasion), and stash (detected via refs/stash).
 *   - escalation ladder: start on the cheapest model, climb a rung after
 *     `stallPatience` consecutive no-progress iterations.
 *   - report: per-iteration record written to .pi/harness-report.json.
 *
 * The model never decides completion - sensor exit codes do.
 *
 * Testability: the agent command is `$LOOP_PI_CMD` (default "pi"), so an
 * integration test can substitute a scripted fake agent.
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import * as os from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	type LadderState,
	type Manifest,
	type Sensor,
	type SensorResult,
	advanceLadder,
	allPass,
	applyFreeze,
	failingNames,
	nonDiscriminating,
	buildPrompt,
	countFailing,
	decide,
	detectPreset,
	fingerprint,
	formatAttemptHistory,
	formatFailures,
	limitsArgs,
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

/**
 * argv prefix that bounds a command with GNU `timeout`.
 *
 * Why not Bun's native spawn `timeout`: it signals only the DIRECT child, so
 * a wedged `bash script.sh` dies while the `sleep`/server/test-runner it
 * forked lives on - holding the inherited stdout pipe open (the loop's own
 * output then never reaches EOF for anything reading it), plus ports and
 * disk. GNU `timeout` runs the command in its own process group and signals
 * the GROUP, which reaps the tree. Verified 2026-08-09: an orphaned
 * grandchild survived the Bun-native kill and was reaped under GNU timeout.
 *
 * `-k 5s` escalates to SIGKILL if the command ignores the initial SIGTERM.
 * Exit status is 124 on timeout, 137 when the KILL escalation was needed.
 */
const KILL_GRACE = "5s";
function timeoutPrefix(timeoutMs?: number): string[] {
	if (!timeoutMs) return [];
	const bin = Bun.which("timeout");
	if (!bin) return []; // fall back to Bun's native (direct-child) timeout
	return [bin, "-k", KILL_GRACE, `${Math.ceil(timeoutMs / 1000)}s`];
}

/** GNU timeout's timed-out exit statuses (124 = TERM fired, 137 = KILL did). */
function isTimeoutExit(code: number): boolean {
	return code === 124 || code === 137;
}

/**
 * Run a command to completion, optionally under a wall-clock deadline.
 *
 * Belt and braces: GNU `timeout` bounds the process GROUP, and Bun's native
 * spawn timeout is kept as a longer backstop in case `timeout` itself is
 * missing or wedged. Classification uses elapsed time as well as the exit
 * status, because 124/137 can legitimately come from the command itself; a
 * fast 137 is an OOM kill and should read as a plain failure, not a hang.
 * Partial output of a killed process is still returned - it is usually the
 * most diagnostic part.
 */
const BACKSTOP_MARGIN_MS = 15_000;
async function sh(
	cmd: string[],
	timeoutMs?: number,
): Promise<{ code: number; out: string; timedOut: boolean; durationMs: number }> {
	const started = Date.now();
	const proc = Bun.spawn([...timeoutPrefix(timeoutMs), ...cmd], {
		stdout: "pipe",
		stderr: "pipe",
		...(timeoutMs
			? { timeout: timeoutMs + BACKSTOP_MARGIN_MS, killSignal: "SIGKILL" as const }
			: {}),
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const durationMs = Date.now() - started;
	const lateEnough = timeoutMs !== undefined && durationMs >= timeoutMs * 0.95;
	const timedOut = lateEnough && (proc.killed || isTimeoutExit(code));
	return { code, out: `${stdout}${stderr}`.trim(), timedOut, durationMs };
}

const git = (...args: string[]) => sh(["git", ...args]);

async function isGitRepo(): Promise<boolean> {
	return (await git("rev-parse", "--is-inside-work-tree")).code === 0;
}

async function isDirty(): Promise<boolean> {
	return (await git("status", "--porcelain")).out.trim() !== "";
}

/**
 * Paths whose WORKTREE content differs from the checkpoint (the index), plus
 * files not in the index at all. Because checkpoint() is `git add -A`, the
 * index IS the last-known-good snapshot, so `git diff --name-only` (no ref)
 * is exactly "what the agent changed since the last checkpoint" - crucially,
 * pre-existing dirty/untracked work staged by the checkpoint is INDEX-content
 * and therefore does NOT show up here (the old HEAD-based diff flagged it,
 * which is how user work got reverted away on 2026-07-24).
 *
 * git reports paths relative to the REPO ROOT, but writeScope globs are
 * cwd-relative. When the loop runs in a subdir of the repo, strip the
 * repo-root->cwd prefix (`git rev-parse --show-prefix`) so the two line up.
 * Changes outside cwd keep their repo-relative form so the scope fence still
 * flags them (they can never match a cwd-relative glob).
 */
async function changedPaths(): Promise<string[]> {
	const tracked = (await git("diff", "--name-only")).out;
	const untracked = (await git("ls-files", "--others", "--exclude-standard")).out;
	const prefix = (await git("rev-parse", "--show-prefix")).out.trim();
	const set = new Set<string>();
	for (const l of `${tracked}\n${untracked}`.split("\n")) {
		const p = l.trim();
		if (!p) continue;
		set.add(prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
	}
	return [...set];
}

/** Promote the working tree to the "best known good" checkpoint (the index). */
async function checkpoint(): Promise<void> {
	await git("add", "-A");
}

/** HEAD sha, or null when the repo has no commits yet. */
async function headSha(): Promise<string | null> {
	const r = await git("rev-parse", "HEAD");
	return r.code === 0 ? r.out.trim() : null;
}

/** Snapshot the checkpoint index as a tree object, for exact restore. */
async function writeTree(): Promise<string> {
	return (await git("write-tree")).out.trim();
}

/** Restore the working tree to the last checkpoint. */
async function rollback(): Promise<void> {
	await git("checkout", "--", ".");
	await git("clean", "-fdq");
}

/**
 * Revert the given paths to the CHECKPOINT (the index), used for scope
 * violations. Restoring from the index - not HEAD - is what makes
 * --allow-dirty safe: uncommitted work staged by checkpoint() comes back
 * verbatim instead of being reset to the last commit. Paths the agent
 * created are absent from the index, so `git clean` removes them.
 */
async function revertPaths(paths: string[]): Promise<void> {
	for (const p of paths) {
		await git("checkout", "--", p); // tracked -> checkpoint (index)
		await git("clean", "-fdq", "--", p); // not in checkpoint -> removed
	}
}

/**
 * Run one sensor under its wall-clock budget and (when configured) inside a
 * transient systemd scope carrying the cgroup caps. The scope matters beyond
 * the caps themselves: it is a cgroup, so a timeout kill reaps the whole
 * process tree instead of orphaning grandchildren a bare SIGKILL would leave
 * holding ports and disk.
 *
 * A timed-out sensor is a FAILURE, never a hang. Before this the loop would
 * block forever on a wedged suite with no rollback, no escalation and no
 * report entry.
 */
async function runSensor(s: Sensor, m: Manifest): Promise<SensorResult> {
	const budget = s.timeoutMs ?? m.timeoutMs;
	const { code, out, timedOut, durationMs } = await sh(
		[...limitsPrefix(m), "bash", "-lc", s.cmd],
		budget,
	);
	return {
		name: s.name,
		cmd: s.cmd,
		ok: code === 0 && !timedOut,
		exitCode: code,
		output: out,
		hint: s.hint,
		timedOut,
		durationMs,
	};
}

/** systemd-run prefix for sensors, or [] when unconfigured/unavailable. */
let limitsWarned = false;
function limitsPrefix(m: Manifest): string[] {
	const args = limitsArgs(m.limits);
	if (args.length === 0) return [];
	if (!Bun.which("systemd-run")) {
		if (!limitsWarned) {
			limitsWarned = true;
			console.warn("  ! limits configured but systemd-run not found; sensors run uncapped.");
		}
		return [];
	}
	return args;
}

async function runAllSensors(m: Manifest): Promise<SensorResult[]> {
	const results: SensorResult[] = [];
	for (const s of m.sensors) {
		process.stdout.write(`    - ${s.name} ... `);
		const r = await runSensor(s, m);
		console.log(
			r.ok
				? "pass"
				: r.timedOut
					? `TIMEOUT (killed after ${Math.round((r.durationMs ?? 0) / 1000)}s)`
					: `FAIL (exit ${r.exitCode})`,
		);
		results.push(r);
	}
	return results;
}

// --- agent sandbox (bwrap) ---------------------------------------------------
// The writeScope fence is repo-scoped; without a jail the agent can write
// anywhere else on the filesystem (other repos, dotfiles) or read secret
// dirs (~/.ssh). When bwrap is available the agent runs with:
//   - / read-only; only cwd (the repo) and /tmp writable
//   - ~/.pi/agent under an OVERLAYFS copy-on-write mount (--overlay-src +
//     --tmp-overlay): pi can write its locks/tmp/session files (they land
//     in an invisible tmpfs and are discarded at exit), but the real
//     config - extensions, skills, prompts, auth.json, settings, and every
//     symlink in the stow chain - is untouchable. This also means loop
//     agent sessions never pollute ~/.pi/agent/sessions or the FTS index.
//     (A plain rw-bind + ro-bind overrides does NOT work: bwrap cannot
//     create file-bind mountpoints over absolute symlink chains like
//     AGENTS.md -> ~/.config/opencode/AGENTS.md, and per-file ro-binds
//     can't stop symlink REPLACEMENT. Verified empirically 2026-07-25.)
//   - secret dirs masked with tmpfs (~/.ssh, ~/.gnupg, ~/.aws, ~/.kube,
//     ~/.config/gh)
//   - network left alone: pi must reach the model gateway; per-port
//     filtering is out of bwrap's scope. Sensors and the judge run
//     OUTSIDE the jail (operator-configured, trusted).
// manifest.sandbox: "auto" (default: jail when bwrap is present, warn +
// run bare otherwise), "require" (abort without bwrap), "off".
// LOOP_SANDBOX env overrides for tests.

const AGENT_DIR = join(os.homedir(), ".pi", "agent");

/** Secret dirs masked with a tmpfs inside the jail (only if they exist). */
const MASKED_DIRS = [".ssh", ".gnupg", ".aws", ".kube", join(".config", "gh")];

let bwrapPath: string | null | undefined; // undefined = not probed yet
function bwrap(): string | null {
	if (bwrapPath === undefined) {
		const override = process.env.LOOP_BWRAP; // test hook, mirrors LOOP_PI_CMD
		bwrapPath = override ? (existsSync(override) ? override : null) : Bun.which("bwrap");
	}
	return bwrapPath;
}

/** bwrap arg vector for the agent jail (everything before the `--`). */
function sandboxArgs(cwd: string): string[] {
	const args = [
		"--die-with-parent",
		"--new-session",
		"--ro-bind",
		"/",
		"/",
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		"--bind",
		cwd,
		cwd,
		"--bind",
		os.tmpdir(),
		os.tmpdir(),
		"--overlay-src",
		AGENT_DIR,
		"--tmp-overlay",
		AGENT_DIR,
	];
	for (const rel of MASKED_DIRS) {
		const p = join(os.homedir(), rel);
		// bwrap can't mount over a symlink (same limitation as file binds),
		// so mask the RESOLVED target; the symlink then points at an empty
		// tmpfs inside the jail, which is exactly the masking intent.
		try {
			const real = realpathSync(p);
			if (statSync(real).isDirectory()) args.push("--tmpfs", real);
		} catch {
			// doesn't exist on this box - nothing to mask
		}
	}
	args.push("--chdir", cwd, "--");
	return args;
}

/**
 * Spawn one agent iteration (pi -p, or $LOOP_PI_CMD in tests) under a
 * wall-clock budget. A wedged agent (stuck tool call, hung gateway read) is
 * worse than a wedged sensor: there is no partial sensor output to diagnose
 * from, the run simply stops. On timeout the agent is killed and the
 * iteration proceeds to sensors + rollback like any other failed attempt.
 */
async function runAgent(
	prompt: string,
	model: string,
	tools: string[],
	sandboxed: boolean,
	timeoutMs: number,
): Promise<{ code: number; timedOut: boolean }> {
	const args = ["-p", prompt, "--tools", tools.join(","), "-a"];
	if (model) args.push("--model", model);
	const cmd = sandboxed ? [bwrap()!, ...sandboxArgs(process.cwd())] : [];
	const started = Date.now();
	// GNU timeout first so the whole agent process GROUP is reaped: `pi -p`
	// spawns tool subprocesses (bash, servers), and orphaning those leaves the
	// loop's inherited stdout pipe open plus ports bound.
	const proc = Bun.spawn([...timeoutPrefix(timeoutMs), ...cmd, PI_CMD, ...args], {
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
		timeout: timeoutMs + BACKSTOP_MARGIN_MS,
		killSignal: "SIGKILL",
	});
	const code = await proc.exited;
	const durationMs = Date.now() - started;
	return {
		code,
		timedOut: durationMs >= timeoutMs * 0.95 && (proc.killed || isTimeoutExit(code)),
	};
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
	/** files the agent touched this iteration (pre-revert); negative knowledge. */
	changedFiles: string[];
	/** loop-level signals for the next prompt (scope reverts, rollback, ref-guard). */
	notes: string[];
	/** the agent exceeded agentTimeoutMs and was killed. */
	agentTimedOut: boolean;
	sensors: { name: string; ok: boolean; exitCode: number; timedOut?: boolean; durationMs?: number }[];
}

interface RunReport {
	startedAt: string;
	finishedAt: string;
	task: string;
	models: string[];
	result: "pass" | "fail" | "already-green" | "trial-stalled";
	iterations: IterationRecord[];
}

/**
 * Re-read the operator-tunable fields from the manifest between iterations.
 *
 * The Bun rewrite's central practice was editing the WORKFLOW mid-run when the
 * output went wrong ("one prompt edit and a few hours later, these things
 * stopped happening") rather than hand-fixing the code. That is impossible if
 * the manifest is read once at startup, so `rules` and `guide` are hot: a
 * human watching the run appends a rule and the next iteration obeys it. Only
 * these two fields are hot - changing sensors or scope mid-run would
 * invalidate the checkpoint/progress accounting.
 */
async function reloadOperatorFields(
	path: string,
	m: Manifest,
): Promise<{ changed: boolean; rules: string[]; guide: string[] }> {
	try {
		const fresh = parseManifest(await Bun.file(path).json());
		const changed =
			JSON.stringify(fresh.rules) !== JSON.stringify(m.rules) ||
			JSON.stringify(fresh.guide) !== JSON.stringify(m.guide);
		return { changed, rules: fresh.rules, guide: fresh.guide };
	} catch {
		// mid-edit / invalid JSON: keep the last good values, never crash the run.
		return { changed: false, rules: m.rules, guide: m.guide };
	}
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
	const freeze = m.baseline || flags.freeze === true;
	// Trial mode: de-risk a long run by proving the sensors + prompt actually
	// converge on a couple of iterations first (the Bun rewrite ported 3 files
	// before all 1,448). A trial that moves nothing is a harness bug - almost
	// always an over-specified or non-discriminating sensor - not a model that
	// needs more iterations, and the verdict says so instead of burning budget.
	let trial = 0;
	if (flags.trial !== undefined) {
		trial = typeof flags.trial === "string" ? Number.parseInt(flags.trial, 10) : 2;
		if (!Number.isInteger(trial) || trial < 1) trial = 2;
		m.maxIterations = Math.min(m.maxIterations, trial);
	}

	console.log(`loop: ${manifestPath}`);
	console.log(`  models:  ${m.models.map((x) => x || "(pi default)").join(" -> ")}`);
	console.log(`  max:     ${m.maxIterations}  stallPatience: ${m.stallPatience}`);
	console.log(
		`  budget:  sensor ${Math.round(m.timeoutMs / 1000)}s, agent ${Math.round(m.agentTimeoutMs / 1000)}s` +
			(m.limits ? `  limits: ${limitsArgs(m.limits).filter((a) => a.includes("=")).join(" ")}` : ""),
	);
	if (trial) console.log(`  TRIAL:   capped at ${m.maxIterations} iteration(s)`);
	if (m.guide.length) console.log(`  guide:   ${m.guide.join(", ")}`);
	if (m.rules.length) console.log(`  rules:   ${m.rules.length} standing rule(s)`);
	console.log(`  tools:   ${m.tools.join(",")}`);
	console.log(`  scope:   ${m.writeScope.length ? m.writeScope.join(", ") : "(unrestricted)"}`);
	console.log(`  sensors: ${m.sensors.map((s) => s.name).join(", ")}`);
	if (freeze) console.log("  freeze:  on (pre-existing failures tolerated)");

	// Agent filesystem sandbox. Sensors + judge stay outside the jail.
	const sbMode = (process.env.LOOP_SANDBOX ?? m.sandbox ?? "auto") as Manifest["sandbox"];
	let sandboxed = false;
	if (sbMode !== "off") {
		if (bwrap()) {
			sandboxed = true;
			console.log("  sandbox: bwrap (ro /, rw repo+pi-state, masked secret dirs)");
		} else if (sbMode === "require") {
			console.error("sandbox: \"require\" but bwrap is not installed - aborting.");
			return 2;
		} else {
			console.warn(
				"  ! bwrap not found: agent runs UNSANDBOXED (writeScope fence is repo-scoped only). Install bubblewrap or set sandbox: \"off\" to silence.",
			);
		}
	} else {
		console.log("  sandbox: off");
	}

	// Refuse to run on a dirty tree by default. With --allow-dirty the loop
	// snapshots the uncommitted state into its first checkpoint (`git add -A`)
	// and every revert/rollback restores from that checkpoint, so pre-existing
	// uncommitted work round-trips intact. It still pollutes the sensor
	// baseline and the loop's notion of "changed", hence the opt-in flag.
	// --dry does no git ops, so it is exempt.
	const gitOn = await isGitRepo();
	if (!dry && gitOn && flags["allow-dirty"] !== true && (await isDirty())) {
		console.error(
			"working tree is dirty. --allow-dirty is safe for uncommitted work (it is captured in the first checkpoint and restored on revert), but the sensor baseline will include it.\nprefer committing first, or re-run with --allow-dirty.",
		);
		return 2;
	}

	// Baseline sensor run (also the --dry output).
	console.log("\n  baseline sensors:");
	const rawBaseline = await runAllSensors(m);
	// A feature sensor (expect: "fail") that passes on the unchanged tree gates
	// nothing - the loop could green out having built nothing. Refuse the run
	// rather than hand back false confidence.
	const dud = nonDiscriminating(m.sensors, rawBaseline);
	if (dud.length) {
		console.error(
			`\nnon-discriminating sensor(s): ${dud.join(", ")}\n` +
				`these declare expect: "fail" but PASS on the unchanged tree, so they gate nothing.\n` +
				`assert the DIFFERENCE the change should make (new column present, old one absent,\n` +
				`filtered output != unfiltered), not something already true. common cause: a CLI that\n` +
				`silently ignores unknown trailing args, so \`cmd newsubcommand\` already exits 0.`,
		);
		return 2;
	}
	// Freeze: sensors already failing at baseline are tolerated (debt), so only
	// NEW failures gate. applyFreeze marks them ok for gating purposes.
	const frozen = freeze ? failingNames(rawBaseline) : new Set<string>();
	if (frozen.size) {
		console.log(`  (freeze: tolerating pre-existing failures: ${[...frozen].join(", ")})`);
	}
	let prev = applyFreeze(rawBaseline, frozen);
	if (allPass(prev)) {
		console.log(
			freeze
				? "\nno failures beyond the frozen baseline (nothing for the loop to do)."
				: "\nall sensors green (nothing for the loop to do).",
		);
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
	// Ref-guard state: HEAD + the checkpoint index as a tree object. HEAD never
	// moves via checkpoint() (git add), so checkpointHead is recorded once;
	// checkpointTree is refreshed after every kept iteration.
	const checkpointHead: string | null = gitOn ? await headSha() : null;
	let checkpointTree = gitOn ? await writeTree() : "";
	// Stash baseline: only entries created DURING the run are flagged.
	let baselineStash = gitOn
		? (await git("rev-parse", "--verify", "refs/stash")).out.trim()
		: "";

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

		// Hot-reload the operator-tunable fields so a watching human can steer
		// the run without killing it.
		const hot = await reloadOperatorFields(manifestPath, m);
		if (hot.changed) {
			m.rules = hot.rules;
			m.guide = hot.guide;
			console.log(`  ~ reloaded manifest rules/guide (${m.rules.length} rule(s))`);
		}

		const feedback = formatFailures(prev);
		const prompt = buildPrompt(
			m.task,
			feedback,
			iterationNotes(report),
			formatAttemptHistory(report.iterations),
			m.rules,
			m.guide,
		);
		const agent = await runAgent(prompt, model, m.tools, sandboxed, m.agentTimeoutMs);
		if (agent.timedOut) {
			notes.push(
				`Your previous iteration was KILLED after ${Math.round(m.agentTimeoutMs / 1000)}s without finishing. Work in smaller steps: make one concrete edit toward the failing check rather than a broad exploration.`,
			);
			console.warn(`  ! agent timed out after ${Math.round(m.agentTimeoutMs / 1000)}s; killed`);
		} else if (agent.code !== 0) {
			console.warn(`  (agent exited ${agent.code}; continuing)`);
		}

		// Ref-guard: the agent may run `git commit` (plan docs often instruct
		// per-task commits). A commit leaves worktree == index, which would make
		// changedPaths() blind AND bake out-of-scope edits into history, and a
		// rollback would leave the commit behind. Undo it BEFORE the footprint
		// capture: HEAD back to the checkpoint. Index restoration happens
		// unconditionally below.
		if (gitOn && checkpointHead) {
			const head = await headSha();
			if (head && head !== checkpointHead) {
				await git("reset", "--soft", checkpointHead);
				notes.push(
					"You moved HEAD (git commit/reset). The loop owns git state: your commit was undone and its changes returned to the worktree for scope review. Do NOT commit - checkpoints are automatic.",
				);
				console.log(
					`  ! agent moved HEAD (${head.slice(0, 8)} != checkpoint ${checkpointHead.slice(0, 8)}); commit undone`,
				);
			}
		}

		// Index-guard: the git index is exclusively governor-owned. Re-impose
		// the checkpoint snapshot after EVERY iteration, not just on HEAD moves.
		// This neutralizes index/worktree attacks that leave HEAD alone:
		//   - `git reset --hard` / `git checkout -- .` / `git stash` (destroy or
		//     hide the staged checkpoint state - a bare reset --hard would
		//     otherwise wipe keeper work that was never committed)
		//   - `git update-index --skip-worktree` / `--assume-unchanged` (hides a
		//     tracked file from `git diff` = a scope-fence evasion; read-tree
		//     rebuilds the index wholesale and drops those flags)
		// For an honest agent the index already IS checkpointTree, so this is a
		// no-op; for anything else the checkpoint is exactly restored.
		if (gitOn) await git("read-tree", checkpointTree);

		// Stash detection: stashed work is invisible to sensors AND the fence.
		// Warn once per NEW entry (a pre-existing user stash is left alone).
		if (gitOn) {
			const stash = (await git("rev-parse", "--verify", "refs/stash")).out.trim();
			if (stash && stash !== baselineStash) {
				baselineStash = stash;
				notes.push(
					"A new git stash entry appeared during your iteration. Stashed work is invisible to the sensors and the scope fence. Never stash - keep your changes in the worktree.",
				);
				console.log("  ! new git stash entry detected (work hidden from sensors/fence)");
			}
		}

		// Capture the attempt's footprint BEFORE any revert: this is the
		// negative knowledge fed to later iterations via formatAttemptHistory.
		const changed = gitOn ? await changedPaths() : [];

		// Enforce write-scope.
		let scopeViolations: string[] = [];
		if (gitOn && m.writeScope.length) {
			const bad = outOfScope(changed, m.writeScope);
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
		const cur = applyFreeze(await runAllSensors(m), frozen);
		const curFailing = countFailing(cur);
		const curFp = fingerprint(cur);
		const d = decide(prevFailing, prevFp, curFailing, curFp);

		console.log(
			`  -> failing ${prevFailing} -> ${curFailing}  (${d.done ? "DONE" : d.progressed ? "progress" : "no progress"})`,
		);

		if (d.keep && gitOn) {
			await checkpoint();
			checkpointTree = await writeTree();
		} else if (gitOn) {
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
			changedFiles: changed,
			notes,
			agentTimedOut: agent.timedOut,
			sensors: cur.map((s) => ({
				name: s.name,
				ok: s.ok,
				exitCode: s.exitCode,
				timedOut: s.timedOut,
				durationMs: s.durationMs,
			})),
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
	if (trial) {
		// Trial verdict: did anything move at all? "No" points at the harness,
		// not at the model - spending 12 more iterations will not fix a sensor
		// that asserts the wrong thing.
		const moved = report.iterations.some((it) => it.progressed);
		report.result = moved ? "fail" : "trial-stalled";
		await writeReport(report);
		if (moved) {
			console.log(
				`\nTRIAL: sensors moved (${report.iterations[0]?.failingBefore} -> ${report.iterations.at(-1)?.failingAfter} failing) but are not green yet.\nThe harness converges - re-run without --trial for the full budget.`,
			);
			return 1;
		}
		console.error(
			`\nTRIAL STALLED: ${m.maxIterations} iteration(s) moved the failing set not at all.\n` +
				"Suspect the HARNESS before the model:\n" +
				"  - is a sensor over-specified (asserting where code lives, or exact prose) rather than behaviour?\n" +
				"  - does a sensor assert something the task never asked for?\n" +
				"  - is the task too vague to act on, or too large for one iteration?\n" +
				"  - did the agent time out (check agentTimedOut in the report)?\n" +
				`Read ${REPORT_PATH}, fix the harness, re-trial.`,
		);
		return 1;
	}
	await writeReport(report);
	console.error(`\nFAIL: sensors still red after ${m.maxIterations} iterations.`);
	return 1;
}

/** Notes derived from the previous iteration record (rollback/escalation). */
function iterationNotes(report: RunReport): string[] {
	const last = report.iterations.at(-1);
	if (!last) return [];
	const notes: string[] = [...last.notes];
	if (!last.kept && !last.agentTimedOut)
		notes.push("The previous attempt was rolled back (no progress); try a different approach.");
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
