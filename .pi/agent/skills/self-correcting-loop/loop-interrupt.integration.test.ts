/**
 * The governor must take its agent down with it.
 *
 * Before this, GNU `timeout` (the agent's outer wrapper) made itself leader of
 * a NEW process group, so a Ctrl-C or terminal hangup ended `loop run` and left
 * `pi -p` running: editing the repo with no checkpoint, scope fence or
 * rollback, and the report never mentioning the iteration it died in
 * (2026-09-07: 1,614 unsupervised lines; 2026-09-09: an agent that "vanished"
 * and had to be diagnosed from `ps`, because the report on disk was the
 * PREVIOUS run's "pass").
 *
 * Pinned here:
 *   1. while the agent runs, the report already says `running` and names the
 *      in-flight iteration (so `loop report` never shows a stale verdict);
 *   2. SIGINT / SIGHUP / SIGTERM to the loop kill the agent's process group
 *      and land a report with `result: "interrupted"`, `finishedAt` set and
 *      the iteration it died in;
 *   3. the interrupted run journals, so `loop history` counts it.
 *
 * Deterministic: the fake agent is `exec sleep <marker>`; an anchored pgrep on
 * the marker is the liveness probe (the test's own argv never matches).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOP = join(import.meta.dir, "loop.ts");
let dir: string;
let journal: string;

async function git(...args: string[]): Promise<void> {
	const p = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
	await p.exited;
}

/** Live processes whose argv is exactly `sleep <mark>`. */
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

const reportPath = () => join(dir, ".pi/harness-report.json");
const report = () => JSON.parse(readFileSync(reportPath(), "utf8"));

function agentScript(mark: string): string {
	const f = join(dir, `agent-${mark}.sh`);
	// One edit first, so an iteration is genuinely in flight; then park.
	writeFileSync(f, `#!/usr/bin/env bash\necho edit > "$PWD/touched-${mark}.txt"\nexec sleep ${mark}\n`);
	chmodSync(f, 0o755);
	return f;
}

async function startLoop(mark: string): Promise<{ proc: Bun.Subprocess; out: Promise<string> }> {
	await Bun.write(
		join(dir, ".pi/harness.json"),
		JSON.stringify({
			task: "park",
			maxIterations: 3,
			timeoutMs: 10_000,
			agentTimeoutMs: 120_000,
			sensors: [{ name: "never", cmd: "false" }],
		}),
	);
	const proc = Bun.spawn(["bun", LOOP, "run", "--allow-dirty"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			LOOP_SANDBOX: "off",
			LOOP_JOURNAL: journal,
			LOOP_PI_CMD: agentScript(mark),
		},
	});
	const out = Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]).then(([a, b]) => a + b);
	return { proc, out };
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "loop-interrupt-"));
	journal = join(dir, "runs.jsonl");
	await git("init", "-q");
	await git("config", "user.email", "t@example.invalid");
	await git("config", "user.name", "t");
	await Bun.write(join(dir, "seed.txt"), "seed\n");
	await git("add", "-A");
	await git("commit", "-qm", "base");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CASES: ["SIGINT" | "SIGHUP" | "SIGTERM", number, string][] = [
	["SIGINT", 130, "94185"],
	["SIGHUP", 129, "94186"],
	["SIGTERM", 143, "94187"],
];

for (const [sig, exitCode, mark] of CASES) {
	test(`${sig} to the loop kills the agent and records the run as interrupted`, async () => {
		const { proc, out } = await startLoop(mark);
		expect(await until(async () => (await alive(mark)) > 0, 20_000)).toBe(true);

		// (1) Honest while running: the previous run's verdict is gone already.
		expect(
			await until(
				() => existsSync(reportPath()) && report().result === "running" && report().inFlight?.iteration === 1,
				5_000,
			),
		).toBe(true);
		expect(report().inFlight.loopPid).toBe(proc.pid);

		// (2) Signal the LOOP, not the agent.
		proc.kill(sig);
		const code = await Promise.race([proc.exited, Bun.sleep(15_000).then(() => -1)]);
		expect(code).toBe(exitCode);
		expect(await until(async () => (await alive(mark)) === 0, 5_000)).toBe(true);

		const r = report();
		expect(r.result).toBe("interrupted");
		expect(r.finishedAt).not.toBe("");
		expect(r.iterations.length).toBe(0);
		expect(r.inFlight.iteration).toBe(1);
		expect(r.inFlight.abortedBy).toBe(sig);
		expect(await out).toContain("interrupted");
	}, 60_000);
}

test("interrupted runs journal, tagged `interrupted`", () => {
	const rows = readFileSync(journal, "utf8")
		.trim()
		.split("\n")
		.map((l: string) => JSON.parse(l));
	expect(rows.length).toBe(CASES.length);
	for (const r of rows) {
		expect(r.result).toBe("interrupted");
		expect(r.failureModes).toContain("interrupted");
	}
});
