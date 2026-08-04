/**
 * `loop verify-sensors` - mutation-testing the sensor set.
 *
 * The fixture deliberately contains ONE sensor with each real-world defect
 * this command exists to catch, taken from actual mistakes:
 *
 *   good-guard   - correct negative check; must be reported `flipped`
 *   stuck-guard  - the `grep -v` inversion: `cmd | grep -qv X` exits 0 as soon
 *                  as ANY line does not match, so it passes with the fault
 *                  present. Must be reported STUCK.
 *   feature      - expect:"fail", red at baseline, canary fakes the feature so
 *                  it must go green. Proves the direction-agnostic flip check
 *                  covers unsatisfiability, not just dead guards.
 *   no-canary    - undeclared; must be `unverified` and must NEVER be executed
 *                  (an expensive judge must cost nothing here).
 *
 * No model, no network - all sensors are shell.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOP = join(import.meta.dir, "loop.ts");
let dir: string;

async function git(...args: string[]): Promise<void> {
	const p = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
	await p.exited;
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "loop-verify-"));
	await git("init", "-q");
	await git("config", "user.email", "t@example.invalid");
	await git("config", "user.name", "t");

	await Bun.write(join(dir, "src.txt"), "clean content\n");
	// Proof that no-canary is never run: the sensor appends here if executed.
	await Bun.write(join(dir, ".pi/harness.json"), JSON.stringify({
		task: "noop",
		timeoutMs: 20000,
		sensors: [
			{
				name: "good-guard",
				cmd: "! rg -q FORBIDDEN src.txt",
				canary: "printf 'FORBIDDEN\\n' >> src.txt",
			},
			{
				// The classic inverted negation: passes whenever ANY line lacks
				// the pattern, which is always true for a multi-line file.
				name: "stuck-guard",
				cmd: "cat src.txt | grep -qv FORBIDDEN",
				canary: "printf 'FORBIDDEN\\n' >> src.txt",
			},
			{
				name: "feature",
				expect: "fail",
				cmd: "test -f feature.txt",
				canary: "printf 'built\\n' > feature.txt",
			},
			{
				name: "no-canary",
				cmd: "printf 'RAN\\n' >> /tmp/loop-verify-ran.txt; true",
			},
		],
	}));
	await git("add", "-A");
	await git("commit", "-qm", "base");
	rmSync("/tmp/loop-verify-ran.txt", { force: true });
}, 30000);

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync("/tmp/loop-verify-ran.txt", { force: true });
});

async function verify(args: string[] = []): Promise<{ code: number; out: string }> {
	const p = Bun.spawn(["bun", LOOP, "verify-sensors", ...args], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, LOOP_SANDBOX: "off" },
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { code, out: `${stdout}${stderr}` };
}

test("catches the stuck sensor, passes the good one, and fails the run", async () => {
	const { code, out } = await verify();

	expect(out).toContain("discriminates");
	expect(out).toContain("STUCK");
	// The decorative sensor is named, not just counted.
	expect(out).toMatch(/STUCK[\s\S]*stuck-guard/);
	// The good guard and the feature sensor both flipped.
	expect(out).toContain("2/4 sensor(s) proven to discriminate; 1 unverified.");
	expect(code).toBe(1);
}, 120_000);

test("a sensor without a canary is reported unverified and never executed", async () => {
	await verify();
	// If no-canary had run even once, this file would exist.
	expect(await Bun.file("/tmp/loop-verify-ran.txt").exists()).toBe(false);
}, 120_000);

test("the working tree is restored after every canary", async () => {
	await verify();
	const p = Bun.spawn(["git", "-C", dir, "status", "--porcelain"], { stdout: "pipe" });
	const status = (await new Response(p.stdout).text()).trim();
	await p.exited;
	expect(status).toBe("");
	// the canary's appended line is gone, the faked feature file is gone
	expect(await Bun.file(join(dir, "src.txt")).text()).toBe("clean content\n");
	expect(await Bun.file(join(dir, "feature.txt")).exists()).toBe(false);
}, 120_000);

test("--only narrows to one sensor, and an unknown name is a usage error", async () => {
	const ok = await verify(["--only", "good-guard"]);
	expect(ok.out).toContain("1/1 sensor(s) proven to discriminate");
	expect(ok.code).toBe(0);

	const bad = await verify(["--only", "nope"]);
	expect(bad.out).toContain("no such sensor(s): nope");
	expect(bad.code).toBe(2);
}, 120_000);

test("--strict makes an undeclared canary a failure", async () => {
	const lax = await verify(["--only", "good-guard"]);
	expect(lax.code).toBe(0);
	const strict = await verify(["--only", "good-guard,no-canary", "--strict"]);
	expect(strict.out).toContain("every sensor must carry a canary");
	expect(strict.code).toBe(1);
}, 120_000);

test("a canary that itself errors is reported, not silently counted as proof", async () => {
	const d2 = mkdtempSync(join(tmpdir(), "loop-verify2-"));
	for (const a of [["init", "-q"], ["config", "user.email", "t@example.invalid"], ["config", "user.name", "t"]]) {
		await Bun.spawn(["git", "-C", d2, ...a], { stdout: "pipe", stderr: "pipe" }).exited;
	}
	await Bun.write(join(d2, "f.txt"), "x\n");
	await Bun.write(join(d2, ".pi/harness.json"), JSON.stringify({
		task: "noop",
		timeoutMs: 20000,
		sensors: [{ name: "broken-canary", cmd: "true", canary: "exit 3" }],
	}));
	await Bun.spawn(["git", "-C", d2, "add", "-A"], { stdout: "pipe" }).exited;
	await Bun.spawn(["git", "-C", d2, "commit", "-qm", "b"], { stdout: "pipe", stderr: "pipe" }).exited;

	const p = Bun.spawn(["bun", LOOP, "verify-sensors"], {
		cwd: d2, stdout: "pipe", stderr: "pipe",
		env: { ...process.env, LOOP_SANDBOX: "off" },
	});
	const [so, se, code] = await Promise.all([
		new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
	]);
	expect(`${so}${se}`).toContain("CANARY");
	expect(`${so}${se}`).toContain("canary exited 3");
	expect(code).toBe(1);
	rmSync(d2, { recursive: true, force: true });
}, 120_000);

test("refuses to run outside a git repo (no way to revert the fault)", async () => {
	const d3 = mkdtempSync(join(tmpdir(), "loop-verify3-"));
	await Bun.write(join(d3, ".pi/harness.json"), JSON.stringify({
		task: "noop",
		sensors: [{ name: "a", cmd: "true", canary: "true" }],
	}));
	const p = Bun.spawn(["bun", LOOP, "verify-sensors"], {
		cwd: d3, stdout: "pipe", stderr: "pipe",
		env: { ...process.env, LOOP_SANDBOX: "off" },
	});
	const [so, se, code] = await Promise.all([
		new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited,
	]);
	expect(`${so}${se}`).toContain("needs a git repo");
	expect(code).toBe(2);
	rmSync(d3, { recursive: true, force: true });
}, 60_000);
