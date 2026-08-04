/**
 * Mid-run steering: `guide` + `rules` reach the prompt, and are RE-READ from
 * the manifest between iterations so a human can correct a running loop
 * instead of killing it ("fix the process that generates the code, not the
 * code").
 *
 * The fake agent dumps the prompt it was handed to a per-iteration file, so
 * these are assertions about what the model actually received - not about
 * what buildPrompt returns in isolation (harness.test.ts covers that).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOP = join(import.meta.dir, "loop.ts");
let dir: string;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "loop-steer-"));

	// Fake agent: append the prompt ($2 of `-p <prompt>`) to a numbered file.
	// It also appends a rule to the manifest on the FIRST iteration, standing
	// in for the human who edits .pi/harness.json while watching the run.
	const agent = join(dir, "agent.sh");
	await Bun.write(
		agent,
		[
			"#!/usr/bin/env bash",
			'n=$(ls "$PROMPT_DIR" | wc -l)',
			'printf "%s" "$2" > "$PROMPT_DIR/prompt-$n.txt"',
			'if [ "$n" = "0" ]; then',
			//  inject a new standing rule mid-run
			`  cat > "${join(dir, ".pi/harness.json")}" <<'J'`,
			JSON.stringify({
				task: "noop",
				maxIterations: 2,
				timeoutMs: 5000,
				agentTimeoutMs: 20000,
				guide: ["CONTRACT.md"],
				rules: ["rule-alpha", "rule-beta-added-midrun"],
				sensors: [{ name: "feature", cmd: "false", expect: "fail" }],
			}),
			"J",
			"fi",
			"exit 0",
		].join("\n"),
	);
	chmodSync(agent, 0o755);
}, 30000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("guide + rules reach iteration 1, and a mid-run rule edit reaches iteration 2", async () => {
	const promptDir = join(dir, "prompts");
	await Bun.write(join(promptDir, ".keep"), ""); // dir exists, ls counts it as 1
	rmSync(join(promptDir, ".keep"));

	await Bun.write(
		join(dir, ".pi/harness.json"),
		JSON.stringify({
			task: "noop",
			maxIterations: 2,
			timeoutMs: 5000,
			agentTimeoutMs: 20000,
			guide: ["CONTRACT.md"],
			rules: ["rule-alpha"],
			sensors: [{ name: "feature", cmd: "false", expect: "fail" }],
		}),
	);

	const p = Bun.spawn(["bun", LOOP, "run"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			LOOP_SANDBOX: "off",
			LOOP_PI_CMD: join(dir, "agent.sh"),
			PROMPT_DIR: promptDir,
		},
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	const out = `${stdout}${stderr}`;

	expect(code).toBe(1); // feature sensor stays red by construction
	expect(out).toContain("guide:   CONTRACT.md");

	const files = readdirSync(promptDir).sort();
	expect(files.length).toBe(2);

	// Iteration 1: guide + the original rule, no feedback machinery yet.
	const first = readFileSync(join(promptDir, files[0]), "utf8");
	expect(first).toContain("READ THESE FILES FIRST");
	expect(first).toContain("CONTRACT.md");
	expect(first).toContain("rule-alpha");
	expect(first).not.toContain("rule-beta-added-midrun");

	// Iteration 2: the rule appended DURING iteration 1 is now in force.
	const second = readFileSync(join(promptDir, files[1]), "utf8");
	expect(second).toContain("rule-beta-added-midrun");
	expect(second).toContain("rule-alpha");
	expect(second).toContain("CONTRACT.md");
	// and the feedback machinery has kicked in
	expect(second).toContain("Automated checks failed");
	expect(second).toContain("Do NOT stub, no-op, or TODO/unimplemented");

	expect(out).toContain("reloaded manifest rules/guide");
}, 90_000);

test("a corrupt mid-run manifest edit is ignored, not fatal", async () => {
	const promptDir = join(dir, "prompts2");
	const breaker = join(dir, "breaker.sh");
	await Bun.write(
		breaker,
		[
			"#!/usr/bin/env bash",
			'n=$(ls "$PROMPT_DIR" 2>/dev/null | wc -l)',
			'mkdir -p "$PROMPT_DIR"',
			'printf "%s" "$2" > "$PROMPT_DIR/p-$n.txt"',
			// half-written JSON, exactly what a save-in-progress looks like
			`printf '{ "task": ' > "${join(dir, ".pi/harness.json")}"`,
			"exit 0",
		].join("\n"),
	);
	chmodSync(breaker, 0o755);

	await Bun.write(
		join(dir, ".pi/harness.json"),
		JSON.stringify({
			task: "noop",
			maxIterations: 2,
			timeoutMs: 5000,
			agentTimeoutMs: 20000,
			rules: ["survivor-rule"],
			sensors: [{ name: "feature", cmd: "false", expect: "fail" }],
		}),
	);

	const p = Bun.spawn(["bun", LOOP, "run"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			LOOP_SANDBOX: "off",
			LOOP_PI_CMD: breaker,
			PROMPT_DIR: promptDir,
		},
	});
	// The verdict line goes to stderr (console.error), so read both streams.
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	const out = `${stdout}${stderr}`;

	// Ran to its normal verdict despite the manifest being invalid mid-run.
	expect(code).toBe(1);
	expect(out).toContain("FAIL: sensors still red");
	// The last-good rules were retained for iteration 2.
	const files = readdirSync(promptDir).sort();
	expect(files.length).toBe(2);
	expect(readFileSync(join(promptDir, files[1]), "utf8")).toContain("survivor-rule");
}, 90_000);
