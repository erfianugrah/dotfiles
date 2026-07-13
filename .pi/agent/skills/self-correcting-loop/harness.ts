/**
 * harness.ts - pure core for the self-correcting loop.
 *
 * NO I/O in this file. Everything here is a pure function so it can be
 * unit-tested via the repo's `tests/run.sh` convention. The impure bits
 * (spawning `pi -p`, running sensor commands) live in loop.ts.
 *
 * Mental model (Bockeler's harness engineering):
 *   - The manifest declares SENSORS = computational feedback controls.
 *   - The loop, not the model, decides "done": a sensor's exit code is the
 *     deterministic gate. The model only ever receives the failing output as
 *     the next iteration's prompt (feed-back), never grades itself.
 */

export interface Sensor {
	/** short stable id, surfaced in feedback (e.g. "build", "vet", "test"). */
	name: string;
	/** shell command; exit 0 = pass, non-zero = fail. stdout+stderr captured. */
	cmd: string;
}

export interface Manifest {
	/** the change the loop should make (feed-forward instruction). */
	task: string;
	/** hard cap on iterations so a stuck loop can't burn tokens forever. */
	maxIterations: number;
	/** pi --model passthrough; null = pi's default model. */
	model: string | null;
	/** pi --tools whitelist for the spawned agent. */
	tools: string[];
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
}

const DEFAULT_TOOLS = ["read", "edit", "write", "bash"];
const DEFAULT_MAX_ITERATIONS = 10;

/**
 * Validate an untyped parsed-JSON value into a Manifest. Throws Error with a
 * precise message on the first problem (this IS the schema - no zod needed).
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

	let model: string | null = null;
	if (r.model !== undefined && r.model !== null) {
		if (typeof r.model !== "string") {
			throw new Error("manifest.model must be a string or null");
		}
		model = r.model;
	}

	let tools = DEFAULT_TOOLS;
	if (r.tools !== undefined) {
		if (
			!Array.isArray(r.tools) ||
			!r.tools.every((t) => typeof t === "string")
		) {
			throw new Error("manifest.tools must be an array of strings");
		}
		tools = r.tools as string[];
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
		return { name: so.name, cmd: so.cmd };
	});

	const names = sensors.map((s) => s.name);
	const dup = names.find((n, i) => names.indexOf(n) !== i);
	if (dup) throw new Error(`manifest.sensors has duplicate name "${dup}"`);

	return { task: r.task, maxIterations, model, tools, sensors };
}

/** All sensors passed? */
export function allPass(results: SensorResult[]): boolean {
	return results.length > 0 && results.every((r) => r.ok);
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
				"\n```",
		)
		.join("\n\n");
}

/**
 * Build the prompt for one iteration. First iteration (no feedback) is just
 * the task. Later iterations append the failing-sensor block plus the
 * anti-cheat guardrails that keep weak models honest.
 */
export function buildPrompt(task: string, feedback?: string): string {
	if (!feedback) return task;
	return (
		`${task}\n\n` +
		"## Automated checks failed on your previous attempt\n" +
		"Fix ONLY what is needed to make these checks pass. Rules:\n" +
		"- Do NOT modify code, config, or tests unrelated to these failures.\n" +
		"- Do NOT delete, skip, or weaken tests to force them green.\n" +
		"- Do NOT change the sensor commands or the manifest.\n" +
		"- Make the smallest change that addresses the reported errors.\n\n" +
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
