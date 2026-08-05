/**
 * A premise (kind: "premise") is a claim about the CURRENT tree that the task's
 * spec rests on. Red at baseline means the spec is wrong, so the run is refused
 * (exit 2) instead of being handed to a model that would satisfy it by making
 * the false claim true.
 *
 * Green premises are dropped from the gating set afterwards, which is why a
 * repo whose only other sensor is green reports "nothing to do" rather than
 * counting the premise as work. Deterministic, no git, no pi.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOP = join(import.meta.dir, "loop.ts");
let dir: string;

async function git(...args: string[]): Promise<void> {
	const p = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
	await p.exited;
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "loop-premise-"));
	mkdirSync(join(dir, ".pi"));
	// The shape of the real case: the spec claimed two files shared a term. One
	// of them does not contain it, so the premise is false before any work.
	writeFileSync(join(dir, "a.md"), "the tenant carries a password_hash\n");
	writeFileSync(join(dir, "b.md"), "the tenant is promoted wholesale\n");
	// The loop rewrites .pi/harness-run.log on every run. Untracked it is
	// recognised as the loop's own artifact and does not count as dirty;
	// COMMITTED it shows up as a modification and the next run refuses. Ignore
	// it, as a real repo does.
	writeFileSync(join(dir, ".gitignore"), ".pi/harness-run.log\n");
	// verify-sensors requires git (the canary plants a real fault and the revert
	// restores from a checkpoint), and a clean tree so a DIRTY verdict is
	// unambiguous.
	await git("init", "-q");
	await git("config", "user.email", "t@example.invalid");
	await git("config", "user.name", "t");
	await git("add", "-A");
	await git("commit", "-qm", "fixture");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Write the manifest AND commit it. Both commands refuse a dirty tree, and
 * rewriting the manifest per test would otherwise leave one.
 */
async function manifest(sensors: unknown[]): Promise<void> {
	writeFileSync(
		join(dir, ".pi/harness.json"),
		JSON.stringify({ task: "unify the primitives both files share", sensors }),
	);
	await git("add", "-A");
	await git("commit", "-qm", "manifest");
}

async function run(args: string[]): Promise<{ code: number; out: string }> {
	const p = Bun.spawn(["bun", LOOP, "run", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
	]);
	return { code: await p.exited, out: stdout + stderr };
}

const shared = (f: string) => ({
	name: `premise-${f}`,
	cmd: `grep -q password_hash ${f}`,
	kind: "premise",
});

test("a false premise refuses the run before a token is spent", async () => {
	await manifest([shared("a.md"), shared("b.md"), { name: "build", cmd: "true" }]);
	const { code, out } = await run([]);
	expect(code).toBe(2);
	expect(out).toContain("false premise(s): premise-b.md");
	// The remedy has to point at the spec. A message that reads like any other
	// red sensor is the failure this feature exists to prevent.
	expect(out).toContain("Fix the SPEC, not the tree");
	// The premise that holds is not named as an offender.
	expect(out).not.toContain("premise-a.md,");
});

test("a premise that holds does not gate the run", async () => {
	await manifest([shared("a.md"), { name: "build", cmd: "true" }]);
	const { code, out } = await run([]);
	expect(code).toBe(0);
	expect(out).toContain("premises hold: premise-a.md");
	expect(out).toContain("nothing for the loop to do");
});

test("a false premise beats a failing guard to the report", async () => {
	// Both are red. The guard is ordinary work; the premise says the work is
	// specified against a repo that does not exist, so it decides the run.
	await manifest([shared("b.md"), { name: "build", cmd: "false" }]);
	const { code, out } = await run(["--dry"]);
	expect(code).toBe(2);
	expect(out).toContain("false premise(s)");
});

test("verify-sensors skips premises instead of calling them uncanaried", async () => {
	await manifest([shared("a.md"), { name: "build", cmd: "true", canary: "true" }]);
	const p = Bun.spawn(["bun", LOOP, "verify-sensors"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
	await p.exited;
	// Not a gap in the sensor set: there is no fault to plant in a claim about
	// the current tree, and the baseline run is what checks it.
	expect(out).toContain("1 premise(s) skipped");
	expect(out).not.toContain("premise-a.md");
});
