/**
 * harness.ts - pure core for the self-correcting loop.
 *
 * NO I/O in this file. Everything here is a pure function so it can be
 * unit-tested via the repo's `tests/run.sh` convention. The impure bits
 * (spawning `pi -p`, running sensors, git checkpointing) live in loop.ts.
 *
 * Mental model (Bockeler's harness engineering):
 *   - The manifest declares SENSORS = computational feedback controls.
 *   - The loop, not the model, decides "done": a sensor's exit code is the
 *     deterministic gate. The model only ever receives failing output as the
 *     next iteration's prompt (feed-back), never grades itself.
 *   - A cybernetic governor around that: escalate model on stall, roll back
 *     regressions, fence writes to a scope. The regulator has more variety
 *     than the thing it regulates (Ashby).
 */

export interface Sensor {
	/** short stable id, surfaced in feedback (e.g. "build", "vet", "test"). */
	name: string;
	/** shell command; exit 0 = pass, non-zero = fail. stdout+stderr captured. */
	cmd: string;
	/**
	 * Optional remediation guidance appended to the feedback when this sensor
	 * fails - a "positive prompt injection" that tells the model HOW to fix the
	 * class of failure, not just that it failed. (OpenAI custom-lint pattern.)
	 */
	hint?: string;
	/**
	 * Baseline expectation. "fail" declares a FEATURE sensor: it must FAIL on
	 * the unchanged tree, because it encodes behaviour that does not exist yet.
	 * A feature sensor that passes at baseline gates nothing - the loop can
	 * green out having built nothing - so the run is refused up front instead.
	 * Default "pass" is the guard/regression case (build, lint, tests).
	 */
	expect?: "pass" | "fail";
	/**
	 * Wall-clock budget for this sensor, overriding manifest.timeoutMs. A
	 * sensor that exceeds it is KILLED and reported as a failure, never as a
	 * hang - an unbounded sensor (wedged test suite, dev server that never
	 * exits) otherwise stalls the whole loop with no rollback and no report.
	 */
	timeoutMs?: number;
	/**
	 * A command that PLANTS the exact fault this sensor exists to catch (commit
	 * the secret, inject the error, delete the test, stub the function, break
	 * the doc). `loop verify-sensors` applies it, asserts the sensor's state
	 * FLIPS, then reverts.
	 *
	 * This is the missing half of the manifest's honesty. `expect: "fail"`
	 * proves a feature sensor is red at baseline; nothing proved it could ever
	 * go green (an unsatisfiable sensor looks identical to a healthy one and
	 * burns the whole budget). A guard is green at baseline by definition;
	 * nothing proved it could ever go red (a guard that cannot fire is
	 * indistinguishable from a repo that is clean). The canary closes both,
	 * because it asserts a FLIP rather than a direction.
	 */
	canary?: string;
}

/**
 * cgroup caps applied to sensor commands via `systemd-run --user --scope`.
 * Sensors run OUTSIDE the bwrap jail (they are operator-configured and
 * trusted) so the jail does not bound them; test suites that exhaust memory,
 * sockets or pids can take the host down. Values are passed verbatim as
 * systemd properties.
 */
export interface ResourceLimits {
	/** systemd MemoryMax, e.g. "8G". */
	memoryMax?: string;
	/** systemd CPUQuota, e.g. "400%" (= 4 cores). */
	cpuQuota?: string;
	/** systemd TasksMax - caps forked processes/threads. */
	tasksMax?: number;
}

export interface Manifest {
	/** the change the loop should make (feed-forward instruction). */
	task: string;
	/** hard cap on iterations so a stuck loop can't burn tokens forever. */
	maxIterations: number;
	/**
	 * Model escalation ladder, cheapest first. "" = pi's default model. The
	 * loop starts on models[0] and climbs a rung after `stallPatience`
	 * consecutive no-progress iterations.
	 */
	models: string[];
	/** consecutive no-progress iterations before escalating one ladder rung. */
	stallPatience: number;
	/**
	 * Freeze mode: tolerate sensors that were ALREADY failing at baseline
	 * (pre-existing debt) and only gate on NEW failures. Lets the loop adopt a
	 * legacy repo without a green-the-world sprint first (ArchUnit `freeze`).
	 */
	baseline: boolean;
	/** pi --tools whitelist for the spawned agent. */
	tools: string[];
	/**
	 * Glob(s) the agent is allowed to write. Edits outside scope are reverted
	 * each iteration. Empty = no restriction. Globs use `*` (within a path
	 * segment) and `**` (across segments).
	 */
	writeScope: string[];
	/** ordered sensors; ALL must pass for the loop to succeed. */
	sensors: Sensor[];
	/**
	 * Agent filesystem sandbox (bwrap). "auto" (default) jails when bwrap is
	 * present, warns + runs bare otherwise; "require" aborts without bwrap;
	 * "off" disables. The writeScope fence is repo-scoped - the jail is what
	 * stops writes OUTSIDE the repo and masks secret dirs (~/.ssh et al).
	 */
	sandbox: "auto" | "off" | "require";
	/** default wall-clock budget per sensor (ms); Sensor.timeoutMs overrides. */
	timeoutMs: number;
	/** wall-clock budget for one agent iteration (ms). */
	agentTimeoutMs: number;
	/** cgroup caps for sensor commands (Linux + systemd only). */
	limits?: ResourceLimits;
	/**
	 * Operator rules appended verbatim to EVERY iteration prompt, and re-read
	 * from the manifest between iterations so a watching human can correct the
	 * loop mid-run without killing it. This is the "fix the process that
	 * generates the code, not the code" lever.
	 */
	rules: string[];
	/**
	 * Paths to binding convention documents (a porting guide, a lifetimes
	 * table, an interface spec). Injected into every prompt as "read these
	 * first, they are binding". Because each iteration is a fresh `pi -p`, an
	 * on-disk guide is the ONLY channel that carries conventions across
	 * iterations. Paths, not contents - the agent reads them with its own tool
	 * so a large guide does not bloat every prompt.
	 */
	guide: string[];
}

export interface SensorResult {
	name: string;
	cmd: string;
	ok: boolean;
	exitCode: number;
	/** combined stdout+stderr. */
	output: string;
	/** remediation guidance carried from the sensor definition. */
	hint?: string;
	/** the sensor exceeded its budget and was killed (output is partial). */
	timedOut?: boolean;
	/** wall-clock the sensor consumed, ms. */
	durationMs?: number;
}

const DEFAULT_TOOLS = ["read", "edit", "write", "bash"];
const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_STALL_PATIENCE = 2;
/** 10 min per sensor: long enough for a real suite, short enough to notice. */
export const DEFAULT_SENSOR_TIMEOUT_MS = 600_000;
/** 30 min per agent iteration; a wedged `pi -p` must not stall the run. */
export const DEFAULT_AGENT_TIMEOUT_MS = 1_800_000;

/**
 * Validate an untyped parsed-JSON value into a Manifest. Throws Error with a
 * precise message on the first problem (this IS the schema - no zod needed).
 *
 * Back-compat: accepts legacy `model` (string|null) and/or the new `models`
 * ladder. Normalizes to a non-empty `models` array where "" means pi default.
 */
export function parseManifest(raw: unknown): Manifest {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("manifest must be a JSON object");
	}
	const r = raw as Record<string, unknown>;

	if (typeof r.task !== "string" || r.task.trim() === "") {
		throw new Error("manifest.task must be a non-empty string");
	}

	const maxIterations =
		r.maxIterations === undefined ? DEFAULT_MAX_ITERATIONS : r.maxIterations;
	if (
		typeof maxIterations !== "number" ||
		!Number.isInteger(maxIterations) ||
		maxIterations < 1
	) {
		throw new Error("manifest.maxIterations must be a positive integer");
	}

	const models = normalizeModels(r.models, r.model);

	const stallPatience =
		r.stallPatience === undefined ? DEFAULT_STALL_PATIENCE : r.stallPatience;
	if (
		typeof stallPatience !== "number" ||
		!Number.isInteger(stallPatience) ||
		stallPatience < 1
	) {
		throw new Error("manifest.stallPatience must be a positive integer");
	}

	let baseline = false;
	if (r.baseline !== undefined) {
		if (typeof r.baseline !== "boolean") {
			throw new Error("manifest.baseline must be a boolean");
		}
		baseline = r.baseline;
	}

	let tools = DEFAULT_TOOLS;
	if (r.tools !== undefined) {
		if (!Array.isArray(r.tools) || !r.tools.every((t) => typeof t === "string")) {
			throw new Error("manifest.tools must be an array of strings");
		}
		tools = r.tools as string[];
	}

	let writeScope: string[] = [];
	if (r.writeScope !== undefined) {
		if (
			!Array.isArray(r.writeScope) ||
			!r.writeScope.every((g) => typeof g === "string")
		) {
			throw new Error("manifest.writeScope must be an array of glob strings");
		}
		writeScope = r.writeScope as string[];
	}

	const timeoutMs = positiveMs(r.timeoutMs, DEFAULT_SENSOR_TIMEOUT_MS, "manifest.timeoutMs");
	const agentTimeoutMs = positiveMs(
		r.agentTimeoutMs,
		DEFAULT_AGENT_TIMEOUT_MS,
		"manifest.agentTimeoutMs",
	);
	const limits = parseLimits(r.limits);
	const rules = parseStringArray(r.rules, "manifest.rules");
	const guide = parseStringArray(r.guide, "manifest.guide");

	let sandbox: Manifest["sandbox"] = "auto";
	if (r.sandbox !== undefined) {
		if (r.sandbox !== "auto" && r.sandbox !== "off" && r.sandbox !== "require") {
			throw new Error('manifest.sandbox must be "auto" | "off" | "require"');
		}
		sandbox = r.sandbox;
	}

	if (!Array.isArray(r.sensors) || r.sensors.length === 0) {
		throw new Error("manifest.sensors must be a non-empty array");
	}
	const sensors: Sensor[] = r.sensors.map((s, i) => {
		if (typeof s !== "object" || s === null) {
			throw new Error(`manifest.sensors[${i}] must be an object`);
		}
		const so = s as Record<string, unknown>;
		if (typeof so.name !== "string" || so.name.trim() === "") {
			throw new Error(`manifest.sensors[${i}].name must be a non-empty string`);
		}
		if (typeof so.cmd !== "string" || so.cmd.trim() === "") {
			throw new Error(`manifest.sensors[${i}].cmd must be a non-empty string`);
		}
		let hint: string | undefined;
		if (so.hint !== undefined) {
			if (typeof so.hint !== "string") {
				throw new Error(`manifest.sensors[${i}].hint must be a string`);
			}
			hint = so.hint;
		}
		let expect: "pass" | "fail" | undefined;
		if (so.expect !== undefined) {
			if (so.expect !== "pass" && so.expect !== "fail") {
				throw new Error(`manifest.sensors[${i}].expect must be "pass" or "fail"`);
			}
			expect = so.expect;
		}
		let canary: string | undefined;
		if (so.canary !== undefined) {
			if (typeof so.canary !== "string" || so.canary.trim() === "") {
				throw new Error(`manifest.sensors[${i}].canary must be a non-empty string`);
			}
			canary = so.canary;
		}
		let sensorTimeout: number | undefined;
		if (so.timeoutMs !== undefined) {
			sensorTimeout = positiveMs(
				so.timeoutMs,
				DEFAULT_SENSOR_TIMEOUT_MS,
				`manifest.sensors[${i}].timeoutMs`,
			);
		}
		return { name: so.name, cmd: so.cmd, hint, expect, timeoutMs: sensorTimeout, canary };
	});

	const names = sensors.map((s) => s.name);
	const dup = names.find((n, i) => names.indexOf(n) !== i);
	if (dup) throw new Error(`manifest.sensors has duplicate name "${dup}"`);

	return {
		task: r.task,
		maxIterations,
		models,
		stallPatience,
		baseline,
		tools,
		writeScope,
		sandbox,
		sensors,
		timeoutMs,
		agentTimeoutMs,
		limits,
		rules,
		guide,
	};
}

/** Optional positive-integer millisecond field with a default. */
function positiveMs(v: unknown, fallback: number, label: string): number {
	if (v === undefined) return fallback;
	if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
		throw new Error(`${label} must be a positive integer (milliseconds)`);
	}
	return v;
}

/** Optional string[] field, defaulting to empty. */
function parseStringArray(v: unknown, label: string): string[] {
	if (v === undefined) return [];
	if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
		throw new Error(`${label} must be an array of strings`);
	}
	return v as string[];
}

/** Validate the optional `limits` object. */
export function parseLimits(v: unknown): ResourceLimits | undefined {
	if (v === undefined) return undefined;
	if (typeof v !== "object" || v === null || Array.isArray(v)) {
		throw new Error("manifest.limits must be an object");
	}
	const o = v as Record<string, unknown>;
	const out: ResourceLimits = {};
	for (const k of ["memoryMax", "cpuQuota"] as const) {
		if (o[k] !== undefined) {
			if (typeof o[k] !== "string" || (o[k] as string).trim() === "") {
				throw new Error(`manifest.limits.${k} must be a non-empty string`);
			}
			out[k] = o[k] as string;
		}
	}
	if (o.tasksMax !== undefined) {
		if (typeof o.tasksMax !== "number" || !Number.isInteger(o.tasksMax) || o.tasksMax < 1) {
			throw new Error("manifest.limits.tasksMax must be a positive integer");
		}
		out.tasksMax = o.tasksMax;
	}
	return Object.keys(out).length ? out : undefined;
}

/**
 * argv prefix that runs a command under a transient systemd scope with the
 * configured cgroup caps. `--scope` runs synchronously in the caller's
 * context and propagates the child's exit status (verified 2026-08-09:
 * `systemd-run -q --user --scope -p MemoryMax=64M -- sh -c 'exit 7'` -> 7).
 * `-q` suppresses the "Running as unit ..." banner so sensor output stays
 * clean. Returns [] when nothing is configured.
 *
 * Bonus over a bare kill-on-timeout: the scope is a cgroup, so killing it
 * takes the whole process tree - grandchildren a plain SIGKILL would orphan.
 */
export function limitsArgs(limits?: ResourceLimits): string[] {
	if (!limits) return [];
	const props: string[] = [];
	if (limits.memoryMax) props.push("-p", `MemoryMax=${limits.memoryMax}`);
	if (limits.cpuQuota) props.push("-p", `CPUQuota=${limits.cpuQuota}`);
	if (limits.tasksMax !== undefined) props.push("-p", `TasksMax=${limits.tasksMax}`);
	if (props.length === 0) return [];
	return ["systemd-run", "-q", "--user", "--scope", ...props, "--"];
}

/** Normalize the {models?, model?} pair into a non-empty ladder ("" = default). */
export function normalizeModels(models: unknown, model: unknown): string[] {
	if (models !== undefined) {
		if (
			!Array.isArray(models) ||
			models.length === 0 ||
			!models.every((m) => typeof m === "string")
		) {
			throw new Error("manifest.models must be a non-empty array of strings");
		}
		return models as string[];
	}
	if (model === undefined || model === null) return [""];
	if (typeof model !== "string") {
		throw new Error("manifest.model must be a string or null");
	}
	return [model];
}

/**
 * Freeze view: a sensor that was already failing at baseline (its name is in
 * `frozen`) is treated as passing for GATING purposes, so the loop tolerates
 * pre-existing debt and only reacts to NEW failures. Empty `frozen` = no-op.
 */
export function applyFreeze(
	results: SensorResult[],
	frozen: Set<string>,
): SensorResult[] {
	if (frozen.size === 0) return results;
	return results.map((r) =>
		!r.ok && frozen.has(r.name) ? { ...r, ok: true } : r,
	);
}

/** Names of sensors currently failing (used to compute the freeze baseline). */
export function failingNames(results: SensorResult[]): Set<string> {
	return new Set(results.filter((r) => !r.ok).map((r) => r.name));
}

/** All sensors passed? */
export function allPass(results: SensorResult[]): boolean {
	return results.length > 0 && results.every((r) => r.ok);
}

/** How many sensors failed. */
export function countFailing(results: SensorResult[]): number {
	return results.filter((r) => !r.ok).length;
}

/**
 * A stable fingerprint of the failing state. Two iterations with the same
 * fingerprint made no progress (the model is stuck).
 */
export function fingerprint(results: SensorResult[]): string {
	return results
		.filter((r) => !r.ok)
		.map((r) => `${r.name}:${r.exitCode}:${r.output}`)
		.join("\u0001");
}

/** Keep head+tail of long output; the middle is the least useful part. */
export function truncate(s: string, max = 4000): string {
	if (s.length <= max) return s;
	const half = Math.max(1, Math.floor(max / 2));
	const dropped = s.length - 2 * half;
	return `${s.slice(0, half)}\n...[${dropped} chars truncated]...\n${s.slice(-half)}`;
}

/**
 * Render the failing sensors into a feedback block for the next prompt.
 * Only failures are included - passing sensors are noise to the model.
 */
export function formatFailures(results: SensorResult[]): string {
	return results
		.filter((r) => !r.ok)
		.map((r) => {
			const head = r.timedOut
				? `### sensor "${r.name}" TIMED OUT after ${Math.round((r.durationMs ?? 0) / 1000)}s (killed; output below is partial)`
				: `### sensor "${r.name}" failed (exit ${r.exitCode})`;
			const timeoutHint = r.timedOut
				? "\n> this did not fail, it HUNG: look for a command that never exits (a server started without a kill, an interactive prompt, an infinite loop/retry), not for a logic bug in the output above"
				: "";
			return (
				`${head}\n` +
				`$ ${r.cmd}\n` +
				"```\n" +
				truncate(r.output).trimEnd() +
				"\n```" +
				timeoutHint +
				(r.hint ? `\n> how to fix: ${r.hint}` : "")
			);
		})
		.join("\n\n");
}

/**
 * One loop iteration's footprint, as needed for negative-knowledge feedback.
 * Mirrors the report record in loop.ts (structural typing keeps the pure
 * core independent of loop.ts's concrete RunReport type).
 */
export interface AttemptRecord {
	iteration: number;
	/** false = rolled back: this approach is a known dead end. */
	kept: boolean;
	/** files the agent touched that iteration (pre-revert). */
	changedFiles: string[];
	failingBefore: number;
	failingAfter: number;
}

/**
 * Render the rolled-back attempts as a negative-knowledge block for the next
 * prompt. Only ROLLED-BACK attempts with file evidence count - kept attempts
 * are visible in the tree itself. Without this, a fresh `pi -p` iteration
 * cannot tell which approaches were already tried and rejected, so it can
 * re-attempt a dead end (OpenAI "exec-plans with decision logs" pattern,
 * mechanically derived instead of agent-narrated). Most recent `max` shown.
 */
export function formatAttemptHistory(attempts: AttemptRecord[], max = 5): string {
	const dead = attempts.filter((a) => !a.kept && a.changedFiles.length > 0);
	if (dead.length === 0) return "";
	const shown = dead.slice(-max);
	const lines = shown.map((a) => {
		const files =
			a.changedFiles.length <= 4
				? a.changedFiles.join(", ")
				: `${a.changedFiles.slice(0, 4).join(", ")} +${a.changedFiles.length - 4} more`;
		return `- iteration ${a.iteration}: touched ${files} (failing ${a.failingBefore} -> ${a.failingAfter}, rolled back)`;
	});
	const overflow = dead.length - shown.length;
	if (overflow > 0) lines.unshift(`(${overflow} earlier rolled-back attempt(s) omitted)`);
	return lines.join("\n");
}

/**
 * Build the prompt for one iteration.
 *
 * `guide` and `rules` are rendered on EVERY iteration including the first:
 * they are standing context, not feedback. The rest (failing sensors,
 * anti-cheat rules, notes, negative-knowledge history) only appears once
 * there is something to react to.
 *
 * The anti-cheat list is empirical. Test-weakening and git-ref mutation came
 * from this loop's own runs; the stub rule and the paragraph-comment rule
 * come from the Bun Rust rewrite, where "get all the crates to compile" was
 * read as "stub out the functions with compilation errors", and workarounds
 * arrived wrapped in long justifying comments. One prompt edit stopped both.
 */
/**
 * Guardrails that hold on EVERY iteration, not just after something fails.
 *
 * These used to live only in the failure-feedback block, which meant a task
 * the model one-shot got NO guardrails at all - the iteration-1 prompt was
 * literally just the task string. Measured 2026-08-04: an A/B of the
 * anti-stub rule returned a null result because all four runs converged in
 * one iteration, so the rule under test was never in the prompt. "Don't
 * weaken tests", "don't stub" and "don't git commit" are properties of how
 * this loop works, not advice about a specific failure.
 */
const STANDING_GUARDRAILS = [
	"Do NOT delete, skip, or weaken tests to make a check pass.",
	"Do NOT stub, no-op, or TODO/unimplemented a function to make a check pass. A check satisfied by a stub is a FAILED iteration, not a green one - implement the behaviour or leave the check red.",
	"If you need a paragraph-long comment to justify why a workaround is OK, the code is wrong - fix the code.",
	"Do NOT change the sensor commands or the manifest.",
	"Do NOT run git commit/reset/stash/tag - the loop owns git state; checkpoints are automatic and ref changes are undone.",
];

export function buildPrompt(
	task: string,
	feedback?: string,
	notes?: string[],
	history?: string,
	rules?: string[],
	guide?: string[],
): string {
	const guideBlock =
		guide && guide.length
			? "\n\n## Binding conventions - READ THESE FILES FIRST\n" +
				`${guide.map((g) => `- ${g}`).join("\n")}\n` +
				"They define how this change must be made. Follow them; do not restate or edit them."
			: "";
	const ruleBlock =
		rules && rules.length
			? `\n\n## Standing rules\n${rules.map((x) => `- ${x}`).join("\n")}`
			: "";
	const guardrails = `\n\n## Ground rules\n${STANDING_GUARDRAILS.map((r) => `- ${r}`).join("\n")}`;
	if (!feedback) return task + guideBlock + ruleBlock + guardrails;
	const noteBlock =
		notes && notes.length
			? `\n\n## Loop notes\n${notes.map((n) => `- ${n}`).join("\n")}`
			: "";
	const historyBlock = history
		? `\n\n## Previous approaches that were rolled back - do not repeat them\n${history}`
		: "";
	return (
		`${task}${guideBlock}${ruleBlock}${guardrails}\n\n` +
		"## Automated checks failed on the previous attempt\n" +
		"Fix ONLY what is needed to make these checks pass. In addition to the ground rules above:\n" +
		"- Do NOT modify code, config, or tests unrelated to these failures.\n" +
		"- Make the smallest change that addresses the reported errors.\n" +
		noteBlock +
		historyBlock +
		"\n\n" +
		feedback
	);
}

/**
 * Sensors that never once passed across the recorded iterations.
 *
 * The trial verdict used to key purely on the AGGREGATE failing count, which
 * is blind to the most common real harness fault: a mostly-good sensor set
 * with ONE unsatisfiable sensor. Progress on the others drops the count, the
 * aggregate says "converging", and the full run then burns every iteration
 * and fails. Measured 2026-08-04:
 *
 *   only-unsatisfiable          trial stalled -> full fail   (correct)
 *   satisfiable + unsatisfiable trial "moved" -> full fail   (WRONG)
 *   fully satisfiable           trial pass    -> full pass   (correct)
 *
 * A sensor that never changes state is the signal the aggregate hides. Note
 * it is evidence, not proof: a sensor needing three iterations looks the same
 * at N=2, which is why the caller reports it as "check these first" rather
 * than declaring the harness broken.
 */
export function stuckSensors(
	iterations: { sensors: { name: string; ok: boolean }[] }[],
): string[] {
	if (iterations.length === 0) return [];
	const everPassed = new Set<string>();
	const seen: string[] = [];
	for (const it of iterations) {
		for (const s of it.sensors) {
			if (!seen.includes(s.name)) seen.push(s.name);
			if (s.ok) everPassed.add(s.name);
		}
	}
	return seen.filter((n) => !everPassed.has(n));
}

// --- sensor verification (canary / mutation testing) ------------------------

/**
 * Outcome of mutation-testing one sensor with its canary.
 *
 * - `flipped`      - the sensor changed state under the planted fault and
 *                    returned to baseline after the revert. It discriminates.
 * - `stuck`        - the sensor reported the SAME state with the fault present.
 *                    It is decoration: it cannot see the thing it guards.
 * - `not-restored` - the sensor flipped but did not return to baseline after
 *                    the revert, so the canary left the tree altered (or the
 *                    sensor is non-deterministic). Either way the result is
 *                    untrustworthy and the working tree needs a look.
 * - `canary-failed`- the canary command itself errored, so nothing was proven.
 * - `unverified`   - no canary declared. Not a failure, but not evidence.
 */
export type CanaryVerdict =
	| "flipped"
	| "stuck"
	| "not-restored"
	| "canary-failed"
	| "unverified";

export interface CanaryResult {
	name: string;
	verdict: CanaryVerdict;
	/** sensor pass/fail before the canary was applied. */
	baselineOk?: boolean;
	/** sensor pass/fail with the fault planted. */
	canaryOk?: boolean;
	/** sensor pass/fail after the revert. */
	restoredOk?: boolean;
	/** detail for canary-failed / not-restored. */
	note?: string;
}

/**
 * Direction-agnostic verdict: a healthy sensor's state must DIFFER under the
 * planted fault, and must come back afterwards.
 *
 * Deliberately not "guard must go red" - a feature sensor (`expect: "fail"`)
 * is red at baseline and its canary is a fake implementation that should turn
 * it green. Asserting the flip covers both without the caller declaring which
 * direction it expected.
 */
export function judgeCanary(
	baselineOk: boolean,
	canaryOk: boolean,
	restoredOk: boolean,
): CanaryVerdict {
	if (canaryOk === baselineOk) return "stuck";
	if (restoredOk !== baselineOk) return "not-restored";
	return "flipped";
}

/** A verdict that means the sensor set cannot be trusted. */
export function isCanaryFailure(v: CanaryVerdict): boolean {
	return v === "stuck" || v === "not-restored" || v === "canary-failed";
}

/** Render the verification results as an operator-readable report. */
export function formatCanaryReport(results: CanaryResult[]): string {
	const glyph: Record<CanaryVerdict, string> = {
		flipped: "ok      ",
		stuck: "STUCK   ",
		"not-restored": "DIRTY   ",
		"canary-failed": "CANARY  ",
		unverified: "unverif.",
	};
	const width = Math.max(4, ...results.map((r) => r.name.length));
	const lines = results.map((r) => {
		const states =
			r.baselineOk === undefined
				? ""
				: `  [base ${r.baselineOk ? "pass" : "fail"} -> canary ${
						r.canaryOk === undefined ? "?" : r.canaryOk ? "pass" : "fail"
					} -> restored ${
						r.restoredOk === undefined ? "?" : r.restoredOk ? "pass" : "fail"
					}]`;
		return `  ${glyph[r.verdict]} ${r.name.padEnd(width)}${states}${r.note ? `  ${r.note}` : ""}`;
	});

	const stuck = results.filter((r) => r.verdict === "stuck").map((r) => r.name);
	const dirty = results.filter((r) => r.verdict === "not-restored").map((r) => r.name);
	const broke = results.filter((r) => r.verdict === "canary-failed").map((r) => r.name);
	const none = results.filter((r) => r.verdict === "unverified").map((r) => r.name);
	const okCount = results.filter((r) => r.verdict === "flipped").length;

	const out = [lines.join("\n"), ""];
	out.push(
		`${okCount}/${results.length} sensor(s) proven to discriminate; ${none.length} unverified.`,
	);
	if (stuck.length)
		out.push(
			`\nSTUCK - these did not change state with the fault planted, so they gate NOTHING:\n  ${stuck.join(", ")}\n` +
				"  Either the check cannot see the fault (wrong path, inverted negation,\n" +
				"  suppressed stderr, substring match) or the canary plants the wrong thing.\n" +
				"  Fix one of the two before trusting a green run.",
		);
	if (dirty.length)
		out.push(
			`\nDIRTY - flipped but did not return to baseline after revert:\n  ${dirty.join(", ")}\n` +
				"  The canary left the tree altered, or the sensor is non-deterministic.\n" +
				"  Inspect `git status` before running anything else.",
		);
	if (broke.length)
		out.push(
			`\nCANARY - the canary command itself failed, so nothing was proven:\n  ${broke.join(", ")}`,
		);
	if (none.length)
		out.push(
			`\nUnverified (no canary declared):\n  ${none.join(", ")}\n` +
				"  Add a `canary` that plants the exact fault each one exists to catch.\n" +
				"  Until then these are assertions, not evidence.",
		);
	return out.join("\n");
}

/** Pure stack-detection for `loop init`: given the filenames present in a dir. */
export function detectPreset(files: string[]): string | null {
	const has = (name: string) => files.includes(name);
	if (has("Cargo.toml")) return "rust";
	if (has("go.mod")) return "go";
	if (files.some((f) => /^astro\.config\.(mjs|ts|js|mts|cjs)$/.test(f)))
		return "astro";
	if (has("package.json")) return "node";
	if (has("pyproject.toml") || has("requirements.txt")) return "python";
	return null;
}

// --- write-scope globbing ---------------------------------------------------

/** Compile a simple glob (`*` within a segment, `**` across segments) to regex. */
export function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i++;
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`);
}

export function matchGlob(path: string, glob: string): boolean {
	return globToRegExp(glob).test(path);
}

/** Paths that are NOT covered by any scope glob. Empty scope = unrestricted. */
/**
 * Paths the loop owns and must never revert, regardless of writeScope.
 *
 * `.pi/` holds the manifest and the run report. The guard reverts anything
 * outside writeScope by restoring it from the checkpoint index, so without
 * this exemption the loop can clobber its own state - including the report
 * that is the only durable record of what a run did.
 */
const LOOP_OWNED = [".pi/"];

export function outOfScope(paths: string[], scope: string[]): string[] {
	if (scope.length === 0) return [];
	return paths.filter(
		(p) => !LOOP_OWNED.some((d) => p.startsWith(d)) && !scope.some((g) => matchGlob(p, g)),
	);
}

// --- loop control decisions -------------------------------------------------

export interface Progress {
	/** all sensors green. */
	done: boolean;
	/**
	 * true if the iteration improved the best-known state: fewer failing
	 * sensors, or the same count but a different failure signature (lateral
	 * move toward a fix). Determines whether we checkpoint or roll back.
	 */
	progressed: boolean;
	/** keep this iteration's changes (checkpoint) vs roll back to best. */
	keep: boolean;
}

export function decide(
	prevFailing: number,
	prevFingerprint: string,
	curFailing: number,
	curFingerprint: string,
): Progress {
	const done = curFailing === 0;
	const progressed =
		done ||
		curFailing < prevFailing ||
		(curFailing === prevFailing && curFingerprint !== prevFingerprint);
	return { done, progressed, keep: progressed };
}

export interface LadderState {
	/** index into models[]. */
	rung: number;
	/** consecutive no-progress iterations at the current rung. */
	noProgress: number;
}

/**
 * Advance the escalation ladder. On progress, reset the stall counter. On no
 * progress, increment it and climb a rung once patience is exhausted (unless
 * already on the top rung).
 */
export function advanceLadder(
	state: LadderState,
	progressed: boolean,
	patience: number,
	ladderLen: number,
): { state: LadderState; escalated: boolean } {
	if (progressed) {
		return { state: { rung: state.rung, noProgress: 0 }, escalated: false };
	}
	const noProgress = state.noProgress + 1;
	if (noProgress >= patience && state.rung < ladderLen - 1) {
		return { state: { rung: state.rung + 1, noProgress: 0 }, escalated: true };
	}
	return { state: { rung: state.rung, noProgress }, escalated: false };
}

export function modelAt(models: string[], rung: number): string {
	return models[Math.min(rung, models.length - 1)];
}

/**
 * Feature sensors (expect: "fail") that PASSED at baseline.
 *
 * Such a sensor gates nothing: the behaviour it claims to require already
 * "works" on the unchanged tree, so the loop can converge having built
 * nothing and still report green. Observed for real - four sensors written
 * against a CLI whose handlers silently ignored unknown trailing args all
 * passed before a line was written.
 */
export function nonDiscriminating(
	sensors: Sensor[],
	baseline: SensorResult[],
): string[] {
	const byName = new Map(baseline.map((r) => [r.name, r]));
	return sensors
		.filter((s) => s.expect === "fail" && byName.get(s.name)?.ok === true)
		.map((s) => s.name);
}
