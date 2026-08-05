/**
 * `loop run > log` INSIDE the repo is silently self-defeating.
 *
 * checkpoint() is `git add -A`, so the redirect target gets staged; every line
 * written afterwards makes it differ from the index, the scope guard sees an
 * out-of-scope modification and reverts it to the checkpoint content. The log
 * truncates at exactly the moment the loop starts working, hiding every
 * iteration header, progress line and the final verdict - it reads as "the
 * loop went silent".
 *
 * Diagnosed 2026-08-04 only after ruling out fds, buffering, output volume and
 * PTYs (a minimal repro proved a real `pi` child does NOT break the parent's
 * descriptors). The discriminating evidence is the 3-way A/B below: writeScope
 * AND log-in-repo truncates; either one alone is fine.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOP = join(import.meta.dir, "loop.ts");
let dir: string;
let agent: string;

async function git(...args: string[]): Promise<void> {
	await Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" }).exited;
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "loop-logpath-"));
	await git("init", "-q");
	await git("config", "user.email", "t@example.invalid");
	await git("config", "user.name", "t");
	agent = join(dir, "agent.sh");
	await Bun.write(agent, "#!/usr/bin/env bash\nmkdir -p ops\ntouch ops/done.txt\nexit 0\n");
	chmodSync(agent, 0o755);
}, 30000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function writeManifest(scope: string[] | null): Promise<void> {
	await Bun.write(
		join(dir, ".pi/harness.json"),
		JSON.stringify({
			task: "noop",
			maxIterations: 2,
			timeoutMs: 20000,
			agentTimeoutMs: 60000,
			...(scope ? { writeScope: scope } : {}),
			sensors: [{ name: "feature", cmd: "test -f ops/done.txt", expect: "fail" }],
		}),
	);
}

/** Run the loop with stdout redirected to `logPath`; return the captured log. */
async function runToLog(logPath: string): Promise<string> {
	rmSync(join(dir, "ops/done.txt"), { force: true });
	const fh = Bun.file(logPath);
	const proc = Bun.spawn(["bash", "-lc", `bun ${LOOP} run --allow-dirty > ${logPath} 2>&1`], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, LOOP_SANDBOX: "off", LOOP_PI_CMD: agent },
	});
	await proc.exited;
	return await fh.text();
}

test("log outside the repo captures the whole run", async () => {
	await writeManifest(["ops/**"]);
	const out = await runToLog(join(tmpdir(), `loop-logpath-outside-${Date.now()}.log`));
	expect(out).toContain("=== iteration 1/");
	expect(out).toMatch(/PASS:|FAIL:/);
	expect(out).not.toContain("INSIDE the repo");
}, 90_000);

test("log inside the repo is truncated by the scope guard, but WARNS first", async () => {
	await writeManifest(["ops/**"]);
	const out = await runToLog(join(dir, "run.log"));
	// The warning is printed before checkpoint() on purpose, so it survives the
	// very revert it describes. Anything emitted later would be reverted away.
	expect(out).toContain("INSIDE the repo");
	expect(out).toContain("Redirect outside the repo");
	// ...and the truncation itself is still real, which is why the warning matters.
	expect(out).not.toContain("=== iteration 1/");
}, 90_000);

test("no writeScope means no scope guard, so an in-repo log survives", async () => {
	await writeManifest(null);
	const out = await runToLog(join(dir, "run2.log"));
	expect(out).toContain("=== iteration 1/");
	expect(out).not.toContain("INSIDE the repo"); // nothing would revert it
}, 90_000);
