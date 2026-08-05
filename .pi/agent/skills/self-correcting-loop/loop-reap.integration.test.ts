/**
 * A sensor or agent must not outlive itself.
 *
 * Found on the first real run: four `eaves serve` processes from a PREVIOUS
 * run were still bound to their sensor ports, so four feature sensors passed
 * against a tree that did not implement the feature. The loop caught it only
 * because those sensors declared `expect: "fail"` and it noticed they were
 * non-discriminating - a feature sensor without `expect` would have been
 * silently green from iteration 0.
 *
 * The leak is the ordinary shape of a server sensor: `go run . serve & SP=$!`
 * ... `kill $SP` kills the `go run` wrapper, not the compiled binary it
 * exec'd. Two mechanisms that looked like they covered this do not:
 *
 *   - `systemd-run --user --scope` (the `limits` prefix) does NOT reap the
 *     cgroup when the main command exits normally - verified on this box with
 *     a backgrounded `sleep`, which survived the scope teardown.
 *   - GNU `timeout` DOES create a process group (it makes itself the leader)
 *     but only signals it when the deadline fires, never on normal exit.
 *
 * So the group exists and nothing kills it. These tests pin the fix.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOP = join(import.meta.dir, "loop.ts");
/** Distinctive durations so pgrep cannot collide with unrelated sleeps. */
const SENSOR_MARK = "94181";
const AGENT_MARK = "94182";
let dir: string;

async function git(...args: string[]): Promise<void> {
	const p = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
	await p.exited;
}

/** PIDs of live processes matching a marker, excluding pgrep itself. */
async function alive(mark: string): Promise<string[]> {
	const p = Bun.spawn(["pgrep", "-f", `sleep ${mark}`], { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(p.stdout).text();
	await p.exited;
	return out.trim().split("\n").filter(Boolean);
}

async function reap(mark: string): Promise<void> {
	const p = Bun.spawn(["pkill", "-f", `sleep ${mark}`], { stdout: "pipe", stderr: "pipe" });
	await p.exited;
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "loop-reap-"));
	await git("init", "-q");
	await git("config", "user.email", "t@example.invalid");
	await git("config", "user.name", "t");
	await Bun.write(join(dir, "seed.txt"), "seed\n");
	await git("add", "-A");
	await git("commit", "-qm", "base");
}, 30000);

afterAll(async () => {
	await reap(SENSOR_MARK);
	await reap(AGENT_MARK);
	rmSync(dir, { recursive: true, force: true });
});

async function run(manifest: Record<string, unknown>, agentScript: string): Promise<number> {
	await Bun.write(join(dir, ".pi/harness.json"), JSON.stringify(manifest));
	const agent = join(dir, "agent.sh");
	await Bun.write(agent, agentScript);
	chmodSync(agent, 0o755);
	const p = Bun.spawn(["bun", LOOP, "run", "--allow-dirty"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, LOOP_SANDBOX: "off", LOOP_PI_CMD: agent },
	});
	await new Response(p.stdout).text();
	return await p.exited;
}

test("a sensor's orphaned background process is reaped, not left holding a port", async () => {
	// The exact leak shape: background a server, kill the WRAPPER, exit 0. The
	// sensor passes and the grandchild survives - until the loop reaps it.
	await run(
		{
			task: "noop",
			maxIterations: 1,
			timeoutMs: 20000,
			agentTimeoutMs: 30000,
			writeScope: ["ops/**"],
			sensors: [
				{
					name: "leaky",
					cmd: `sleep ${SENSOR_MARK} >/dev/null 2>&1 & SP=$!; sleep 0.3; kill $SP 2>/dev/null; true`,
				},
			],
		},
		"#!/usr/bin/env bash\nexit 0\n",
	);

	expect(await alive(SENSOR_MARK)).toEqual([]);
}, 60000);

test("an agent's orphaned background process is reaped too", async () => {
	// Same class, likelier cause: the agent starts a dev server to try the
	// thing by hand and never stops it. Nothing downstream would notice - the
	// next run's sensors would just find the port already answering.
	await run(
		{
			task: "noop",
			maxIterations: 1,
			timeoutMs: 20000,
			agentTimeoutMs: 30000,
			writeScope: ["ops/**"],
			sensors: [{ name: "feature", cmd: "test -f ops/done.txt", expect: "fail" }],
		},
		`#!/usr/bin/env bash\nsleep ${AGENT_MARK} >/dev/null 2>&1 &\nmkdir -p ops\ntouch ops/done.txt\nexit 0\n`,
	);

	expect(await alive(AGENT_MARK)).toEqual([]);
}, 60000);

test("reaping does not disturb the sensor's own verdict or output", async () => {
	// The group kill happens after stdout/stderr are drained and the exit code
	// is read. A reaper that raced the read would eat the diagnosis.
	await Bun.write(
		join(dir, ".pi/harness.json"),
		JSON.stringify({
			task: "noop",
			maxIterations: 1,
			timeoutMs: 20000,
			agentTimeoutMs: 30000,
			writeScope: ["ops/**"],
			sensors: [
				{
					name: "talks-then-leaks",
					cmd: `sleep ${SENSOR_MARK} >/dev/null 2>&1 & echo 'DIAGNOSIS: port already bound'; exit 1`,
				},
			],
		}),
	);
	const agent = join(dir, "agent.sh");
	await Bun.write(agent, "#!/usr/bin/env bash\nexit 0\n");
	chmodSync(agent, 0o755);
	const p = Bun.spawn(["bun", LOOP, "run", "--allow-dirty"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, LOOP_SANDBOX: "off", LOOP_PI_CMD: agent },
	});
	await new Response(p.stdout).text();
	await p.exited;

	const report = await Bun.file(join(dir, ".pi/harness-report.json")).json();
	const s = report.iterations[0].sensors.find(
		(x: { name: string }) => x.name === "talks-then-leaks",
	);
	expect(s.ok).toBe(false);
	expect(s.output).toContain("DIAGNOSIS: port already bound");
	expect(await alive(SENSOR_MARK)).toEqual([]);
}, 60000);
