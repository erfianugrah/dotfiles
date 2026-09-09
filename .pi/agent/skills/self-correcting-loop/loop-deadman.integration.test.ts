/**
 * The sandboxed agent dies with the loop even when no handler can run.
 *
 * Signal handlers cover Ctrl-C, `kill` and hangup (loop-interrupt tests). A
 * SIGKILLed or OOM-killed loop runs nothing, so the jail's own lifetime has
 * to be bound to the loop's: bwrap must be the loop's DIRECT child for
 * `--die-with-parent` to watch the right process. Before this the outer
 * wrapper was GNU `timeout`, so the jail died with timeout (which nothing
 * killed) rather than with the governor.
 *
 * Moving `timeout` inside the jail must not cost the deadline: its 124 exit
 * status passes through bwrap unchanged, so a timed-out agent is still
 * classified as such. Both pinned here; both skip when bwrap is absent.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOP = join(import.meta.dir, "loop.ts");
const hasBwrap = Bun.which("bwrap") !== null;
let dir: string;

async function alive(mark: string): Promise<number> {
	const p = Bun.spawn(["pgrep", "-fc", `^sleep ${mark}$`], { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(p.stdout).text();
	await p.exited;
	return Number(out.trim() || 0);
}

async function until(pred: () => Promise<boolean> | boolean, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await pred()) return true;
		await Bun.sleep(100);
	}
	return pred();
}

const report = () => JSON.parse(readFileSync(join(dir, ".pi/harness-report.json"), "utf8"));

function agentScript(name: string, body: string): string {
	const f = join(dir, `${name}.sh`);
	writeFileSync(f, `#!/usr/bin/env bash\n${body}\n`);
	chmodSync(f, 0o755);
	return f;
}

async function run(
	manifest: Record<string, unknown>,
	agent: string,
): Promise<{ proc: Bun.Subprocess; out: Promise<string> }> {
	await Bun.write(join(dir, ".pi/harness.json"), JSON.stringify(manifest));
	const proc = Bun.spawn(["bun", LOOP, "run"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		// "require": fail loudly if the jail cannot be set up, rather than
		// silently testing the bare path.
		env: { ...process.env, LOOP_SANDBOX: "require", LOOP_PI_CMD: agent },
	});
	const out = Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]).then(([a, b]) => a + b);
	return { proc, out };
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "loop-deadman-"));
	if (!hasBwrap) console.log("    (skipped: bwrap not installed)");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("SIGKILL to the loop takes the jailed agent down with it", async () => {
	if (!hasBwrap) return;
	const mark = "94188";
	const { proc } = await run(
		{
			task: "park",
			maxIterations: 2,
			timeoutMs: 10_000,
			agentTimeoutMs: 120_000,
			sensors: [{ name: "never", cmd: "false" }],
		},
		agentScript("park", `exec sleep ${mark}`),
	);
	expect(await until(async () => (await alive(mark)) > 0, 20_000)).toBe(true);

	proc.kill("SIGKILL");
	await proc.exited;
	// No handler ran; the kernel's parent-death signal is the only thing left.
	expect(await until(async () => (await alive(mark)) === 0, 5_000)).toBe(true);

	// A SIGKILLed loop cannot finalize its report - it stays `running` with
	// the in-flight iteration, which is exactly what `loop report` flags.
	expect(report().result).toBe("running");
	expect(report().inFlight.iteration).toBe(1);
	const rep = Bun.spawn(["bun", LOOP, "report"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	const text = (await new Response(rep.stdout).text()) + (await new Response(rep.stderr).text());
	await rep.exited;
	expect(text).toContain("in flight: iteration 1");
	expect(text).toContain("gone");
}, 60_000);

test("a timed-out agent inside the jail is still classified as a timeout", async () => {
	if (!hasBwrap) return;
	const started = Date.now();
	const { proc, out } = await run(
		{
			task: "noop",
			maxIterations: 1,
			timeoutMs: 5_000,
			agentTimeoutMs: 1_500,
			sensors: [{ name: "feature", cmd: "false", expect: "fail" }],
		},
		agentScript("hang", "exec sleep 300"),
	);
	const code = await proc.exited;
	const text = await out;
	expect(text).toContain("agent timed out after");
	expect(code).toBe(1);
	expect(report().iterations[0].agentTimedOut).toBe(true);
	expect(Date.now() - started).toBeLessThan(45_000);
}, 90_000);
