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

test("the loop never stages its own artifacts", async () => {
	// checkpoint() is `git add -A`, so the run log landed in the index - and
	// therefore in the diff a judge sensor reviews (flagged as out-of-scope
	// noise, correctly) and in any commit the operator makes after a run.
	// Excluding them from the dirty check and the scope fence was not enough.
	await run();
	const staged = await git("diff", "--cached", "--name-only");
	expect(staged).not.toContain("harness-run.log");
	expect(staged).not.toContain("harness-report.json");
	const indexed = await git("ls-files", "--", ".pi");
	expect(indexed).not.toContain("harness-run.log");
	expect(indexed).not.toContain("harness-report.json");
	expect(indexed).toContain("harness.json"); // the manifest IS user work
});

test("a rollback does not delete the trace that explains it", async () => {
	// Unstaged artifacts are untracked, so the rollback's `git clean -fdq`
	// would delete the run log at exactly the moment it matters most.
	const idle = join(dir, "idle.sh");
	await Bun.write(idle, "#!/usr/bin/env bash\nexit 0\n"); // never satisfies the sensor
	chmodSync(idle, 0o755);
	rmSync(join(dir, "ops/done.txt"), { force: true }); // sensor must start red
	rmSync(join(dir, ".pi/harness-run.log"), { force: true });

	const p = Bun.spawn(["bun", LOOP, "run", "--allow-dirty"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, LOOP_SANDBOX: "off", LOOP_PI_CMD: idle },
	});
	const out = await new Response(p.stdout).text();
	await p.exited;

	expect(out).toContain("iteration");
	expect(existsSync(join(dir, ".pi/harness-run.log"))).toBe(true);
	const log = await Bun.file(join(dir, ".pi/harness-run.log")).text();
	expect(log).toContain("=== iteration 1/");
});

test("a failing sensor's output survives into the report and `loop report`", async () => {
	// The run's most expensive artifact - an LLM sensor's verdict - was being
	// discarded: the report kept ok/exitCode/durationMs and dropped the text,
	// so "never passed: judge" was the whole diagnosis and the reasoning had to
	// be recovered by re-running the sensor by hand.
	await manifest({
		maxIterations: 1,
		sensors: [
			{
				name: "reviewer",
				cmd: "echo 'REJECT: the handler is a stub' >&2; exit 1",
				hint: "address the review",
			},
		],
	});
	await run();

	const report = await Bun.file(join(dir, ".pi/harness-report.json")).json();
	const sensor = report.iterations[0].sensors.find((s: { name: string }) => s.name === "reviewer");
	expect(sensor.ok).toBe(false);
	expect(sensor.output).toContain("REJECT: the handler is a stub");

	const p = Bun.spawn(["bun", LOOP, "report"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	const out = await new Response(p.stdout).text();
	expect(await p.exited).toBe(0);
	expect(out).toContain("never passed: reviewer");
	expect(out).toContain("REJECT: the handler is a stub");

	await manifest(); // restore the shared fixture for any later test
});

test("the exact prompt each iteration was given is recorded and readable", async () => {
	// Three of the four defects found on the first real run came from reading
	// an agent prompt by hand out of `ps` output: the loop's own log inside the
	// reviewed diff, a baseline judge verdict presented as "the previous
	// attempt failed", and the size of the assembled feedback. The prompt was
	// the one thing the loop built and never showed back.
	rmSync(join(dir, ".pi/harness-prompts"), { recursive: true, force: true });
	await manifest({ maxIterations: 1 });
	await run();

	const recorded = await Bun.file(join(dir, ".pi/harness-prompts/iteration-1.txt")).text();
	expect(recorded).toContain("noop"); // the task
	expect(recorded.length).toBeGreaterThan(0);

	const report = await Bun.file(join(dir, ".pi/harness-report.json")).json();
	expect(report.iterations[0].promptChars).toBe(recorded.length);

	const p = Bun.spawn(["bun", LOOP, "report", "--prompt", "1"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(p.stdout).text();
	expect(await p.exited).toBe(0);
	expect(out).toContain("noop");

	// An iteration that never ran is a usage error, and says what IS available.
	const q = Bun.spawn(["bun", LOOP, "report", "--prompt", "9"], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const err = await new Response(q.stderr).text();
	expect(await q.exited).toBe(2);
	expect(err).toContain("no prompt recorded for iteration 9");
	expect(err).toContain("have: 1");
});

test("recorded prompts are loop artifacts, not agent work", async () => {
	// Same trap as the run log, one directory deeper: a per-iteration file
	// written mid-run would otherwise be staged by checkpoint(), enter the
	// scope fence, pollute changed-files, and be deleted by a rollback clean.
	await manifest({ maxIterations: 1 });
	await run();

	const staged = await git("diff", "--cached", "--name-only");
	expect(staged).not.toContain("harness-prompts");

	const report = await Bun.file(join(dir, ".pi/harness-report.json")).json();
	for (const it of report.iterations) {
		expect(it.changedFiles ?? []).not.toContain(".pi/harness-prompts/iteration-1.txt");
		expect(it.scopeViolations ?? []).toEqual([]);
	}
	expect(existsSync(join(dir, ".pi/harness-prompts/iteration-1.txt"))).toBe(true);
});
