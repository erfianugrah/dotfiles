/**
 * Regression test: writeScope enforcement when the loop runs in a SUBDIR of
 * the git repo.
 *
 * The bug: `changedPaths()` returned git's repo-root-relative paths
 * (`sub/bin/migrate.sh`) but writeScope globs are cwd-relative
 * (`bin/migrate.sh`), so a legit in-scope edit was mis-flagged as
 * out-of-scope. The fix strips the repo-root->cwd prefix via
 * `git rev-parse --show-prefix` before matching.
 *
 * Fake agent (keyed off an out-of-repo counter):
 *   iter 1: edit sub/bin/migrate.sh (IN scope) -> must NOT be flagged, passes.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOP = join(import.meta.dir, "loop.ts");
let repo: string;
let sub: string;
let counter: string;
let fake: string;

async function sh(cmd: string[], cwd: string) {
	const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	await p.exited;
}

beforeAll(async () => {
	repo = mkdtempSync(join(tmpdir(), "loop-sub-repo-"));
	const box = mkdtempSync(join(tmpdir(), "loop-sub-box-"));
	counter = join(box, "counter");
	fake = join(box, "fake-agent.sh");

	// Fake agent writes the in-scope target (relative to cwd = the subdir).
	writeFileSync(
		fake,
		`#!/usr/bin/env bash
n=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$COUNTER_FILE"
case "$n" in
  1) echo migrated > bin/migrate.sh ;;
  *) : ;;
esac
exit 0
`,
	);
	chmodSync(fake, 0o755);

	// Repo root has an unrelated file; the workload lives in a nested subdir.
	sub = join(repo, "labs", "mongo-supabase-wrapper");
	mkdirSync(join(sub, "bin"), { recursive: true });
	writeFileSync(join(repo, "README.md"), "root\n");
	writeFileSync(join(sub, "bin", "migrate.sh"), "");
	await Bun.write(
		join(sub, ".pi/harness.json"),
		JSON.stringify({
			task: "make migrate.sh pass",
			maxIterations: 3,
			models: ["weak"],
			stallPatience: 2,
			tools: ["read", "edit", "write", "bash"],
			writeScope: ["bin/migrate.sh"],
			sensors: [{ name: "M", cmd: "grep -q migrated bin/migrate.sh" }],
		}),
	);

	await sh(["git", "init", "-q"], repo);
	await sh(["git", "config", "user.email", "t@t.t"], repo);
	await sh(["git", "config", "user.name", "t"], repo);
	await sh(["git", "add", "-A"], repo);
	await sh(["git", "commit", "-q", "-m", "baseline"], repo);
}, 30000);

afterAll(() => {
	rmSync(repo, { recursive: true, force: true });
});

test("subdir cwd: in-scope edit is not mis-flagged as out-of-scope", async () => {
	const proc = Bun.spawn(["bun", LOOP, "run"], {
		cwd: sub, // <-- run inside the subdir, not the repo root
		env: { ...process.env, LOOP_PI_CMD: fake, COUNTER_FILE: counter },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	expect(code).toBe(0);

	const report = JSON.parse(readFileSync(join(sub, ".pi/harness-report.json"), "utf8"));
	expect(report.result).toBe("pass");

	// The single iteration must NOT have flagged the in-scope edit.
	expect(report.iterations[0].scopeViolations).toEqual([]);
	// And the edit survived (not reverted by a spurious scope violation).
	expect(readFileSync(join(sub, "bin", "migrate.sh"), "utf8")).toContain("migrated");
}, 30000);
