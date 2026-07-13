#!/usr/bin/env bun
/**
 * loop.ts - sensor-gated self-correcting loop driver.
 *
 *   bun loop.ts run   [--manifest .pi/harness.json] [--model M] [--max N] [--dry]
 *   bun loop.ts init  [go|node|rust|astro|python]   [--force]
 *
 * The driver spawns a FRESH `pi -p` each iteration (no shared conversation -
 * state lives in the filesystem + the injected sensor feedback), runs the
 * manifest's sensors, and only stops when every sensor exits 0 or the
 * iteration budget is spent. The model never decides completion.
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
	type Manifest,
	type SensorResult,
	allPass,
	buildPrompt,
	detectPreset,
	formatFailures,
	parseManifest,
} from "./harness.ts";

const SCRIPT_DIR = dirname(Bun.fileURLToPath(import.meta.url));
const PRESET_DIR = join(SCRIPT_DIR, "presets");
const DEFAULT_MANIFEST = ".pi/harness.json";

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

/** Run one sensor command, capturing combined stdout+stderr. */
async function runSensor(name: string, cmd: string): Promise<SensorResult> {
	const proc = Bun.spawn(["bash", "-lc", cmd], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return {
		name,
		cmd,
		ok: exitCode === 0,
		exitCode,
		output: `${stdout}${stderr}`.trim(),
	};
}

async function runAllSensors(m: Manifest): Promise<SensorResult[]> {
	const results: SensorResult[] = [];
	for (const s of m.sensors) {
		process.stdout.write(`  - sensor ${s.name} ... `);
		const r = await runSensor(s.name, s.cmd);
		console.log(r.ok ? "pass" : `FAIL (exit ${r.exitCode})`);
		results.push(r);
	}
	return results;
}

/** Spawn `pi -p` for one iteration, streaming its output through. */
async function runPi(
	prompt: string,
	m: Manifest,
): Promise<number> {
	const args = ["-p", prompt, "--tools", m.tools.join(","), "-a"];
	if (m.model) args.push("--model", m.model);
	const proc = Bun.spawn(["pi", ...args], {
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
	});
	return await proc.exited;
}

async function cmdRun(flags: Record<string, string | boolean>): Promise<number> {
	const manifestPath = resolve(
		typeof flags.manifest === "string" ? flags.manifest : DEFAULT_MANIFEST,
	);
	if (!existsSync(manifestPath)) {
		console.error(
			`no manifest at ${manifestPath}\nrun \`bun loop.ts init\` first.`,
		);
		return 2;
	}

	let manifest: Manifest;
	try {
		manifest = parseManifest(await Bun.file(manifestPath).json());
	} catch (err) {
		console.error(`invalid manifest: ${(err as Error).message}`);
		return 2;
	}

	// CLI overrides.
	if (typeof flags.model === "string") manifest.model = flags.model;
	if (typeof flags.max === "string") {
		const n = Number.parseInt(flags.max, 10);
		if (Number.isInteger(n) && n > 0) manifest.maxIterations = n;
	}
	const dry = flags.dry === true;

	console.log(`loop: ${manifestPath}`);
	console.log(`  model:  ${manifest.model ?? "(pi default)"}`);
	console.log(`  max:    ${manifest.maxIterations}`);
	console.log(`  tools:  ${manifest.tools.join(",")}`);
	console.log(`  sensors:${manifest.sensors.map((s) => s.name).join(", ")}`);

	if (dry) {
		// --dry: just run the sensors once, report, don't spawn pi.
		console.log("\n[dry run] running sensors once, not spawning pi:\n");
		const results = await runAllSensors(manifest);
		if (allPass(results)) {
			console.log("\nall sensors green (nothing for the loop to do).");
			return 0;
		}
		console.log(`\n${formatFailures(results)}`);
		return 1;
	}

	let feedback: string | undefined;
	for (let i = 1; i <= manifest.maxIterations; i++) {
		console.log(`\n=== iteration ${i}/${manifest.maxIterations} ===`);
		const prompt = buildPrompt(manifest.task, feedback);
		const piExit = await runPi(prompt, manifest);
		if (piExit !== 0) {
			console.warn(`  (pi exited ${piExit}; running sensors anyway)`);
		}
		console.log("  running sensors:");
		const results = await runAllSensors(manifest);
		if (allPass(results)) {
			console.log(`\nPASS: all sensors green on iteration ${i}.`);
			return 0;
		}
		feedback = formatFailures(results);
	}
	console.error(
		`\nFAIL: sensors still red after ${manifest.maxIterations} iterations.`,
	);
	return 1;
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

	// Validate the preset before copying so a broken preset can't be written.
	const presetJson = await Bun.file(presetPath).json();
	parseManifest(presetJson);

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
			console.error(
				`unknown command "${cmd}"\nusage: bun loop.ts [run|init] ...`,
			);
			code = 2;
	}
	process.exit(code);
}

// Only run when executed directly, not when imported by tests.
if (basename(Bun.main) === "loop.ts") {
	await main();
}
