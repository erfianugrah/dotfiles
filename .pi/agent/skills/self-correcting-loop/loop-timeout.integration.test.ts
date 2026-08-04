/**
 * Wall-clock budgets: a sensor or agent that HANGS must fail the iteration,
 * not the run.
 *
 * Before this, both spawn sites were bare `Bun.spawn` with no deadline, so a
 * wedged test suite or a stuck `pi -p` stalled the loop forever - no
 * rollback, no escalation, no report entry, and (for the agent case) not even
 * partial sensor output to diagnose from. These tests are the A/B: each one
 * would hang indefinitely if the deadline were removed, so the bun-test
 * per-test timeout is the backstop that proves the feature works.
 *
 * Deterministic: no git, no real model - the "agent" is a scripted fake via
 * $LOOP_PI_CMD, same idiom as the other integration tests.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOP = join(import.meta.dir, "loop.ts");
let dir: string;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "loop-timeout-"));

	// A fake agent that hangs forever: proves agentTimeoutMs kills it.
	const hangingAgent = join(dir, "hang-agent.sh");
	await Bun.write(hangingAgent, "#!/usr/bin/env bash\nsleep 600\n");
	chmodSync(hangingAgent, 0o755);

	// A fake agent that returns immediately and changes nothing.
	const noopAgent = join(dir, "noop-agent.sh");
	await Bun.write(noopAgent, "#!/usr/bin/env bash\nexit 0\n");
	chmodSync(noopAgent, 0o755);
}, 30000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function writeManifest(m: Record<string, unknown>): Promise<void> {
	await Bun.write(join(dir, ".pi/harness.json"), JSON.stringify(m));
}

async function run(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
	const p = Bun.spawn(["bun", LOOP, "run", ...args], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, LOOP_SANDBOX: "off", ...env },
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { code, out: `${stdout}${stderr}` };
}

test("a hanging sensor is killed at its budget and reported as a failure", async () => {
	// `sleep 600` would outlive the test; the 1.5s budget must cut it short.
	await writeManifest({
		task: "noop",
		timeoutMs: 1500,
		sensors: [{ name: "wedged", cmd: "sleep 600" }],
	});
	const started = Date.now();
	const { code, out } = await run(["--dry"]);
	const elapsed = Date.now() - started;

	expect(out).toContain("TIMEOUT (killed after");
	expect(out).toContain("did not fail, it HUNG");
	expect(code).toBe(1); // dry run with a red sensor
	expect(elapsed).toBeLessThan(30_000); // the whole point: it did not hang
}, 60_000);

test("per-sensor timeoutMs overrides the manifest default", async () => {
	// Manifest default is generous; the sensor's own budget is what bites.
	await writeManifest({
		task: "noop",
		timeoutMs: 600_000,
		sensors: [{ name: "wedged", cmd: "sleep 600", timeoutMs: 1200 }],
	});
	const { out } = await run(["--dry"]);
	expect(out).toContain("TIMEOUT (killed after");
}, 60_000);

test("a fast sensor is untouched by the budget", async () => {
	await writeManifest({
		task: "noop",
		timeoutMs: 5000,
		sensors: [{ name: "quick", cmd: "true" }],
	});
	const { code, out } = await run(["--dry"]);
	expect(out).not.toContain("TIMEOUT");
	expect(code).toBe(0); // all green => nothing to do
}, 30_000);

test("a hanging AGENT is killed, and the iteration continues to sensors", async () => {
	// Feature sensor stays red forever, so the loop would iterate to its cap;
	// each iteration's agent hangs and must be reaped at agentTimeoutMs.
	await writeManifest({
		task: "noop",
		maxIterations: 1,
		timeoutMs: 5000,
		agentTimeoutMs: 1500,
		sensors: [{ name: "feature", cmd: "false", expect: "fail" }],
	});
	const started = Date.now();
	const { code, out } = await run([], { LOOP_PI_CMD: join(dir, "hang-agent.sh") });
	const elapsed = Date.now() - started;

	expect(out).toContain("agent timed out after");
	// The run reached its verdict rather than stalling on the wedged agent.
	expect(code).toBe(1);
	expect(elapsed).toBeLessThan(45_000);
}, 90_000);

// The sandboxed path is the DEFAULT, and it is the one that leaks: bwrap's
// --new-session setsid()s out of the process group GNU `timeout` signals, so
// the deadline reaps bwrap while its descendants live on. The original
// timeout tests all ran LOOP_SANDBOX=off and were blind to it. A killed-but-
// running agent is the worst failure the loop has: it keeps editing the repo
// against stale sensor feedback, outside checkpoint/rollback accounting.
// --unshare-pid makes bwrap PID 1 of a namespace the kernel tears down whole.
test("a timed-out agent leaves NO live descendant inside the bwrap jail", async () => {
	if (!Bun.which("bwrap")) return; // sandbox unavailable; nothing to assert
	const marker = `loopjailcanary${Date.now()}`;
	const jailAgent = join(dir, "jail-agent.sh");
	// A forked grandchild: bash stays alive waiting, the sleep is the leaf.
	await Bun.write(jailAgent, `#!/usr/bin/env bash\nsleep 400 & # ${marker}\nwait\n`);
	chmodSync(jailAgent, 0o755);

	await writeManifest({
		task: "noop",
		maxIterations: 1,
		timeoutMs: 5000,
		agentTimeoutMs: 3000,
		sensors: [{ name: "feature", cmd: "false", expect: "fail" }],
	});

	const p = Bun.spawn(["bun", LOOP, "run"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		// NOTE: LOOP_SANDBOX deliberately NOT set to "off" - jail is the point.
		env: { ...process.env, LOOP_PI_CMD: jailAgent },
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	const out = `${stdout}${stderr}`;

	expect(out).toContain("sandbox: bwrap");
	expect(out).toContain("agent timed out after");
	expect(code).toBe(1);

	// The load-bearing assertion: nothing from the jail outlived the deadline.
	const survivors = Bun.spawnSync(["pgrep", "-fc", marker]);
	const n = Number.parseInt(survivors.stdout.toString().trim() || "0", 10);
	if (n > 0) Bun.spawnSync(["pkill", "-f", marker]); // don't leak into the suite
	expect(n).toBe(0);
}, 90_000);

test("--trial stalls loudly and points at the harness, not the model", async () => {
	// The fake agent changes nothing, so the failing set cannot move. That is
	// the signature of a broken sensor, and the trial verdict must say so
	// instead of recommending more iterations.
	await writeManifest({
		task: "noop",
		maxIterations: 12,
		timeoutMs: 5000,
		agentTimeoutMs: 10_000,
		sensors: [{ name: "feature", cmd: "false", expect: "fail" }],
	});
	const { code, out } = await run(["--trial", "1"], {
		LOOP_PI_CMD: join(dir, "noop-agent.sh"),
	});

	expect(out).toContain("TRIAL:   capped at 1 iteration(s)");
	expect(out).toContain("TRIAL STALLED");
	expect(out).toContain("Suspect the HARNESS before the model");
	expect(code).toBe(1);

	const report = await Bun.file(join(dir, ".pi/harness-report.json")).json();
	expect(report.result).toBe("trial-stalled");
	expect(report.iterations).toHaveLength(1);
}, 90_000);
