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
}

const DEFAULT_TOOLS = ["read", "edit", "write", "bash"];
const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_STALL_PATIENCE = 2;

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
		return { name: so.name, cmd: so.cmd, hint };
	});

	const names = sensors.map((s) => s.name);
	const dup = names.find((n, i) => names.indexOf(n) !== i);
	if (dup) throw new Error(`manifest.sensors has duplicate name "${dup}"`);

	return { task: r.task, maxIterations, models, stallPatience, tools, writeScope, sensors };
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
		.map(
			(r) =>
				`### sensor "${r.name}" failed (exit ${r.exitCode})\n` +
				`$ ${r.cmd}\n` +
				"```\n" +
				truncate(r.output).trimEnd() +
				"\n```" +
				(r.hint ? `\n> how to fix: ${r.hint}` : ""),
		)
		.join("\n\n");
}

/**
 * Build the prompt for one iteration. First iteration (no feedback) is just
 * the task. Later iterations append the failing-sensor block plus anti-cheat
 * guardrails. `notes` carries loop-level signals (rollback happened, escalated,
 * out-of-scope edits reverted).
 */
export function buildPrompt(task: string, feedback?: string, notes?: string[]): string {
	if (!feedback) return task;
	const noteBlock =
		notes && notes.length
			? `\n\n## Loop notes\n${notes.map((n) => `- ${n}`).join("\n")}`
			: "";
	return (
		`${task}\n\n` +
		"## Automated checks failed on the previous attempt\n" +
		"Fix ONLY what is needed to make these checks pass. Rules:\n" +
		"- Do NOT modify code, config, or tests unrelated to these failures.\n" +
		"- Do NOT delete, skip, or weaken tests to force them green.\n" +
		"- Do NOT change the sensor commands or the manifest.\n" +
		"- Make the smallest change that addresses the reported errors.\n" +
		noteBlock +
		"\n\n" +
		feedback
	);
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
export function outOfScope(paths: string[], scope: string[]): string[] {
	if (scope.length === 0) return [];
	return paths.filter((p) => !scope.some((g) => matchGlob(p, g)));
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
