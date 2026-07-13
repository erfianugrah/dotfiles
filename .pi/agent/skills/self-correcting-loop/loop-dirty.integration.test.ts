/**
 * F3 regression: the loop must refuse a dirty working tree (its git-add-A
 * checkpoint would fold uncommitted work into its snapshots), unless
 * --allow-dirty is passed.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOP = join(import.meta.dir, "loop.ts");
let repo: string;

async function sh(cmd: string[], cwd: string) {
	await Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" }).exited;
}

beforeAll(async () => {
	repo = mkdtempSync(join(tmpdir(), "loop-dirty-"));
	await Bun.write(
		join(repo, ".pi/harness.json"),
		JSON.stringify({
			task: "noop",
			sensors: [{ name: "ok", cmd: "true" }], // green at baseline
		}),
	);
	await sh(["git", "init", "-q"], repo);
	await sh(["git", "config", "user.email", "t@t.t"], repo);
	await sh(["git", "config", "user.name", "t"], repo);
	await sh(["git", "add", "-A"], repo);
	await sh(["git", "commit", "-q", "-m", "baseline"], repo);
	// make the tree dirty (untracked file)
	writeFileSync(join(repo, "scratch.txt"), "uncommitted work\n");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

async function run(args: string[]): Promise<{ code: number; out: string }> {
	const p = Bun.spawn(["bun", LOOP, "run", ...args], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { code, out: stdout + stderr };
}

test("aborts (exit 2) on a dirty tree without --allow-dirty", async () => {
	const { code, out } = await run([]);
	expect(code).toBe(2);
	expect(out).toContain("dirty");
});

test("--allow-dirty proceeds (baseline green -> exit 0)", async () => {
	const { code } = await run(["--allow-dirty"]);
	expect(code).toBe(0);
});

test("--dry is exempt from the dirty guard", async () => {
	const { code } = await run(["--dry"]);
	expect(code).toBe(0); // baseline sensor is green
});
