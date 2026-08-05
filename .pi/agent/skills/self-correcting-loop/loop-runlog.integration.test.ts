/**
 * The loop owns its own trace, and its own artifacts are not "user dirt".
 *
 * Before this the only durable record was the JSON report; the readable trace
 * depended on the operator redirecting stdout, and redirecting the obvious way
 * (into the repo) was silently eaten by the scope guard. `.pi/harness-run.log`
 * removes the whole class - `.pi/**` is scope-exempt, so it survives.
 *
 * The subtle half is the second group: a loop-generated artifact must not make
 * the tree look dirty, must not enter the scope fence, and must not show up in
 * the changed-files history. Getting that wrong made the loop refuse to start
 * because of its own output (it broke 8 existing tests in one go).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOP = join(import.meta.dir, "loop.ts");
let dir: string;
let agent: string;

async function git(...args: string[]): Promise<string> {
	const p = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(p.stdout).text();
	await p.exited;
	return out;
}

async function manifest(extra: Record<string, unknown> = {}): Promise<void> {
	await Bun.write(
		join(dir, ".pi/harness.json"),
		JSON.stringify({
			task: "noop",
			maxIterations: 2,
			timeoutMs: 20000,
			agentTimeoutMs: 60000,
			writeScope: ["ops/**"],
			sensors: [{ name: "feature", cmd: "test -f ops/done.txt", expect: "fail" }],
			...extra,
		}),
	);
}

/** Run with NO redirection at all - the point is that a trace still exists. */
async function run(args: string[] = ["--allow-dirty"]): Promise<number> {
	rmSync(join(dir, "ops/done.txt"), { force: true });
	const p = Bun.spawn(["bun", LOOP, "run", ...args], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, LOOP_SANDBOX: "off", LOOP_PI_CMD: agent },
	});
	await new Response(p.stdout).text();
	return await p.exited;
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "loop-runlog-"));
	await git("init", "-q");
	await git("config", "user.email", "t@example.invalid");
	await git("config", "user.name", "t");
	agent = join(dir, "agent.sh");
	await Bun.write(agent, "#!/usr/bin/env bash\nmkdir -p ops\ntouch ops/done.txt\nexit 0\n");
	chmodSync(agent, 0o755);
	await Bun.write(join(dir, "seed.txt"), "seed\n");
	// Manifest must exist BEFORE the commit: an untracked .pi/harness.json is
	// real dirt and the loop is right to refuse a run over it.
	await manifest();
	await git("add", "-A");
	await git("commit", "-qm", "base");
}, 30000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a trace exists with no redirection, and carries the whole run", async () => {
	expect(await run()).toBe(0);
	const log = await Bun.file(join(dir, ".pi/harness-run.log")).text();
	expect(log).toContain("=== iteration 1/");
	expect(log).toMatch(/PASS:|FAIL:/);
	expect(log).toContain("===== loop run ");
});

test("appends across runs rather than truncating history", async () => {
	await run();
	const log = await Bun.file(join(dir, ".pi/harness-run.log")).text();
	expect(log.match(/===== loop run /g)?.length ?? 0).toBeGreaterThanOrEqual(2);
});

test("--no-log opts out", async () => {
	rmSync(join(dir, ".pi/harness-run.log"), { force: true });
	await run(["--allow-dirty", "--no-log"]);
	expect(existsSync(join(dir, ".pi/harness-run.log"))).toBe(false);
});

test("the loop's OWN artifacts do not count as a dirty tree", async () => {
	// Regression: startRunLog() creates the log BEFORE the dirty check, so the
	// loop refused to start because of its own output. The report has the same
	// shape - written at the end of every run, dirtying the tree for the next.
	await run(); // leaves harness-run.log + harness-report.json behind

	// Restore everything the agent/checkpoint touched, keeping only the loop's
	// own untracked artifacts. Anything else really is dirt and SHOULD block.
	// NOT `reset --hard`: checkpoint() staged the artifacts, and they are not in
	// HEAD, so a hard reset would delete the very files under test. Unstage,
	// restore tracked files, then clean untracked EXCEPT the loop's own .pi.
	await git("reset", "-q");
	await git("checkout", "--", ".");
	await git("clean", "-fdq", "-e", ".pi");
	const porcelain = await git("status", "--porcelain");
	expect(porcelain).toContain(".pi/harness-run.log");
	expect(porcelain).toContain(".pi/harness-report.json");
	// Only artifacts are outstanding, so a bare run (no --allow-dirty) starts.
	expect(await run([])).toBe(0);
});

test("loop artifacts never enter the scope fence or changed-files history", async () => {
	await run();
	const report = await Bun.file(join(dir, ".pi/harness-report.json")).json();
	for (const it of report.iterations) {
		expect(it.changedFiles ?? []).not.toContain(".pi/harness-run.log");
		expect(it.changedFiles ?? []).not.toContain(".pi/harness-report.json");
		expect(it.scopeViolations ?? []).toEqual([]);
	}
});

test("loop report renders the run, and fails cleanly with no report", async () => {
	await run();
	const p = Bun.spawn(["bun", LOOP, "report"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	const out = await new Response(p.stdout).text();
	expect(await p.exited).toBe(0);
	expect(out).toContain("result:");
	expect(out).toContain("it  failing");
	expect(out).toContain("full trace: .pi/harness-run.log");

	rmSync(join(dir, ".pi/harness-report.json"), { force: true });
	const q = Bun.spawn(["bun", LOOP, "report"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	const err = await new Response(q.stderr).text();
	expect(await q.exited).toBe(2);
	expect(err).toContain("no report at");
});
